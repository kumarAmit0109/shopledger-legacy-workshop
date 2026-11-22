'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const config = require('../config');

test('invoice figures match billed totals, GST, and line GST breakdown', function () {
  const items = [
    { id: 1, name: 'Rice', sku: 'GRN-001', hsn: '1006', price: 5000, qty: 1 },
    { id: 2, name: 'Tea', sku: 'BEV-001', hsn: '0902', price: 140, qty: 2 }
  ];
  const billed = pricing.computeTotals(items, 'WHOLESALE15');
  const printed = invoice.computeInvoiceFigures({ items: items, coupon: 'WHOLESALE15' });

  assert.equal(printed.subtotal, billed.subtotal);
  assert.equal(printed.discount, billed.discount);
  assert.equal(printed.tax, billed.tax);
  assert.equal(printed.total, billed.total);
  assert.deepEqual(printed.rows.map(function (row) { return row.lineTax; }), billed.lines.map(function (line) { return line.tax; }));
  assert.equal(printed.rows[0].gstPercent, 5);
  assert.equal(printed.rows[1].gstPercent, 18);
});

test('invoice preserves stored billed totals if current tax configuration changes', function () {
  const previousRate = config.tax.hsnSlabs['1006'];
  config.tax.hsnSlabs['1006'] = 18;

  try {
    const printed = invoice.computeInvoiceFigures({
      subtotal: 100,
      discount: 0,
      tax: 5,
      total: 105,
      coupon: '',
      items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }]
    });

    assert.equal(printed.subtotal, 100);
    assert.equal(printed.discount, 0);
    assert.equal(printed.tax, 5);
    assert.equal(printed.total, 105);
    assert.equal(printed.cgst + printed.sgst, printed.tax);
    assert.equal(printed.rows.reduce(function (sum, row) { return sum + row.lineTax; }, 0), printed.tax);
    assert.equal(printed.rows[0].gstPercent, 5);
  } finally {
    config.tax.hsnSlabs['1006'] = previousRate;
  }
});

test('order preserves billed line GST for invoices after tax configuration changes', function () {
  const items = [{ id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }];
  const billed = pricing.computeTotals(items, '');
  const db = { orders: [], nextOrderId: 1001 };
  const order = orders.add(db, {
    items: items,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total,
    taxLines: billed.lines
  });
  const previousRate = config.tax.hsnSlabs['1006'];
  config.tax.hsnSlabs['1006'] = 18;

  try {
    assert.deepEqual(order.taxLines, billed.lines);
    const printed = invoice.computeInvoiceFigures(order);
    assert.equal(printed.rows[0].gstPercent, 5);
    assert.equal(printed.rows[0].lineTax, 50);
    assert.equal(printed.tax, 50);
    assert.equal(printed.total, 1050);
  } finally {
    config.tax.hsnSlabs['1006'] = previousRate;
  }
});

test('invoice uses the billed HSN slab when gstRate is absent', function () {
  const items = [
    { id: 1, name: 'Rice', sku: 'GRN-001', hsn: '1006', price: 1000, qty: 1 }
  ];
  const billed = pricing.computeTotals(items, '');
  const printed = invoice.computeInvoiceFigures({ items: items, coupon: '' });

  assert.equal(billed.tax, 50);
  assert.equal(billed.total, 1050);
  assert.equal(printed.rows[0].gstPercent, 5);
  assert.equal(printed.tax, billed.tax);
  assert.equal(printed.total, billed.total);
});

test('invoice uses the billed coupon discount, GST, and total', function () {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 5000, qty: 1 }
  ];
  const billed = pricing.computeTotals(items, 'WHOLESALE15');
  const printed = invoice.computeInvoiceFigures({ items: items, coupon: 'WHOLESALE15' });

  assert.equal(billed.discount, 400);
  assert.equal(billed.tax, 230);
  assert.equal(billed.total, 4830);

  assert.equal(printed.discount, billed.discount);
  assert.equal(printed.tax, billed.tax);
  assert.equal(printed.total, billed.total);
});

test('invoice preserves an explicit zero GST rate', function () {
  const items = [
    { id: 1, name: 'Tax-exempt item', hsn: '1006', price: 100, qty: 1, gstRate: 0 }
  ];
  const billed = pricing.computeTotals(items, '');
  const printed = invoice.computeInvoiceFigures({ items: items, coupon: '' });

  assert.equal(billed.tax, 0);
  assert.equal(printed.rows[0].gstPercent, 0);
  assert.equal(printed.tax, billed.tax);
});

test('invoice splits its computed tax into CGST and SGST that sum to that tax', function () {
  const figures = invoice.computeInvoiceFigures({
    items: [{ name: 'Item', price: 10, qty: 1, gstRate: 5 }],
    coupon: ''
  });

  assert.equal(figures.tax, 0.5);
  assert.equal(figures.cgst, 0.25);
  assert.equal(figures.sgst, 0.25);
  assert.equal(figures.cgst + figures.sgst, figures.tax);
});

test('rendered invoice does not show a reconciliation warning when it matches the billed total', function () {
  const html = invoice.render({
    id: 1001,
    date: '22/11/2026',
    status: 'completed',
    customer: 'Walk-in',
    paymentMode: 'cash',
    coupon: '',
    subtotal: 1000,
    discount: 0,
    tax: 50,
    total: 1050,
    items: [{ name: 'Rice', hsn: '1006', price: 1000, qty: 1 }]
  });

  assert.match(html, /Invoice Total<\/td><td class="r">[^<]*1050\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});
