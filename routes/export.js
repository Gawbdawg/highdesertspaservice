// CSV exports for the Settings tab's backup buttons — a safety net independent of the
// server's own disk, especially useful before persistent storage is set up.
const express = require('express');
const store = require('../lib/store');
const { toCsv } = require('../lib/csv');
const router = express.Router();

function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows, columns));
}

router.get('/customers.csv', (req, res) => {
  const owners = store.getAll('owners');
  const rows = store.getAll('customers').map((c) => ({
    ...c,
    ownerName: c.ownerId ? ((owners.find((o) => o.id === c.ownerId) || {}).name || '') : '',
  }));
  sendCsv(res, 'customers.csv', rows, [
    { key: 'id', header: 'ID' },
    { key: 'name', header: 'Name' },
    { key: 'type', header: 'Type' },
    { key: 'phone', header: 'Phone' },
    { key: 'email', header: 'Email' },
    { key: 'address', header: 'Address' },
    { key: 'notes', header: 'Notes' },
    { key: 'ownerName', header: 'Owner' },
    { key: 'equipment.brand', header: 'Equipment brand' },
    { key: 'equipment.model', header: 'Equipment model' },
    { key: 'equipment.serialNumber', header: 'Serial number' },
    { key: 'equipment.filterType', header: 'Filter type' },
    { key: 'equipment.filterLastChanged', header: 'Filter last changed' },
  ]);
});

router.get('/appointments.csv', (req, res) => {
  const customers = store.getAll('customers');
  const technicians = store.getAll('technicians');
  const rows = store.getAll('appointments')
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .map((a) => ({
      ...a,
      customerName: (customers.find((c) => c.id === a.customerId) || {}).name || '',
      technicianName: a.technicianId ? ((technicians.find((t) => t.id === a.technicianId) || {}).name || '') : '',
    }));
  sendCsv(res, 'appointments.csv', rows, [
    { key: 'id', header: 'ID' },
    { key: 'date', header: 'Date' },
    { key: 'startTime', header: 'Start time' },
    { key: 'endTime', header: 'End time' },
    { key: 'customerName', header: 'Customer' },
    { key: 'technicianName', header: 'Technician' },
    { key: 'serviceType', header: 'Service' },
    { key: 'status', header: 'Status' },
    { key: 'chlorine', header: 'Chlorine' },
    { key: 'ph', header: 'pH' },
    { key: 'alkalinity', header: 'Alkalinity' },
    { key: 'notes', header: 'Notes' },
  ]);
});

router.get('/invoices.csv', (req, res) => {
  const customers = store.getAll('customers');
  const rows = store.getAll('invoices')
    .sort((a, b) => (a.issuedDate || '').localeCompare(b.issuedDate || ''))
    .map((i) => ({
      ...i,
      customerName: (customers.find((c) => c.id === i.customerId) || {}).name || '',
    }));
  sendCsv(res, 'invoices.csv', rows, [
    { key: 'id', header: 'ID' },
    { key: 'customerName', header: 'Customer' },
    { key: 'amount', header: 'Amount' },
    { key: 'issuedDate', header: 'Issued' },
    { key: 'dueDate', header: 'Due' },
    { key: 'status', header: 'Status' },
    { key: 'notes', header: 'Notes' },
  ]);
});

module.exports = router;
