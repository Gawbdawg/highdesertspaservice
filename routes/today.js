const express = require('express');
const store = require('../lib/store');
const ai = require('../lib/ai');
const router = express.Router();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// Days until a filter is "due" based on its interval — negative means overdue. Mirrors
// public/app.js's filterDaysRemaining exactly (kept here too since this is a server-side
// aggregation the old function never needed to be).
function filterDaysRemaining(equipment) {
  if (!equipment || !equipment.filterLastChanged || !equipment.filterIntervalDays) return null;
  const changed = new Date(equipment.filterLastChanged + 'T00:00:00');
  const due = new Date(changed.getTime() + Number(equipment.filterIntervalDays) * 24 * 60 * 60 * 1000);
  return Math.ceil((due - new Date()) / (24 * 60 * 60 * 1000));
}

// Everything office staff might need to act on today, collapsed into one payload:
// today's job count, an AI (or template) briefing sentence, and a flat, priority-sorted
// list of "attention cards" — overdue jobs, unpaid invoices, equipment due for a filter
// change, new self-signups, and pending service requests. Every card carries enough IDs
// for the frontend to jump straight to the record or resolve it in one click.
router.get('/', async (req, res) => {
  const today = todayStr();
  const customers = store.getAll('customers');
  const technicians = store.getAll('technicians');
  const owners = store.getAll('owners');
  const appointments = store.getAll('appointments');
  const invoices = store.getAll('invoices');
  const serviceRequests = store.getAll('serviceRequests');
  const timeEntries = store.getAll('timeEntries');

  const customerName = (id) => (customers.find((c) => c.id === id) || {}).name || 'Unknown';
  const techName = (id) => (technicians.find((t) => t.id === id) || {}).name || 'Unassigned';

  const todaysJobs = appointments.filter((a) => a.date === today);

  // Same "uncompleted tasks" definition as Reports: still-scheduled with a date that's
  // already passed. Oldest first — that's the one worth naming in the briefing.
  const overdueJobs = appointments
    .filter((a) => a.status === 'scheduled' && a.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => ({ ...a, customerName: customerName(a.customerId), daysOverdue: daysBetween(a.date, today) }));

  const unpaidInvoices = invoices
    .filter((i) => i.status === 'sent' && i.dueDate && i.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((i) => {
      const invCustomerName = i.ownerId
        ? (owners.find((o) => o.id === i.ownerId) || {}).name || 'Unknown owner'
        : customerName(i.customerId);
      return { ...i, customerName: invCustomerName, daysOverdue: daysBetween(i.dueDate, today) };
    });

  // Filter-change reminders double as this app's "predictive maintenance" signal — real
  // sensor-driven failure prediction isn't in scope for a spa route business, but a
  // filter that's overdue for a change is a genuine, data-backed early-warning sign
  // (reduced flow, strained pump) worth surfacing the same way.
  const filterFlags = customers
    .filter((c) => c.equipment && c.equipment.filterLastChanged && c.equipment.filterIntervalDays)
    .map((c) => ({ customer: c, daysRemaining: filterDaysRemaining(c.equipment) }))
    .filter((f) => f.daysRemaining !== null && f.daysRemaining <= 14)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

  const newSignups = owners.filter((o) => {
    if (o.signupSource !== 'self' || !o.createdAt) return false;
    return daysBetween(o.createdAt.slice(0, 10), today) <= 7;
  });

  const pendingRequests = serviceRequests
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (a.requestedDate || '').localeCompare(b.requestedDate || ''));

  const attention = [];

  overdueJobs.forEach((a) => attention.push({
    id: `overdue_job_${a.id}`,
    kind: 'overdue_job',
    title: `${a.customerName} — overdue`,
    subtitle: `${a.serviceType || 'Service'} was due ${a.date} (${a.daysOverdue} day${a.daysOverdue === 1 ? '' : 's'} ago)`,
    appointmentId: a.id,
    customerId: a.customerId,
    actionLabel: 'Mark complete',
  }));

  unpaidInvoices.forEach((i) => attention.push({
    id: `unpaid_invoice_${i.id}`,
    kind: 'unpaid_invoice',
    title: `${i.customerName} — $${Number(i.amount || 0).toFixed(0)} overdue`,
    subtitle: `Invoice was due ${i.dueDate} (${i.daysOverdue} day${i.daysOverdue === 1 ? '' : 's'} ago)`,
    invoiceId: i.id,
    actionLabel: 'Send reminder',
  }));

  filterFlags.forEach((f) => attention.push({
    id: `filter_${f.customer.id}`,
    kind: 'filter_due',
    title: `${f.customer.name} — filter ${f.daysRemaining < 0 ? 'overdue' : 'due soon'}`,
    subtitle: f.daysRemaining < 0
      ? `Filter change was due ${Math.abs(f.daysRemaining)} day${Math.abs(f.daysRemaining) === 1 ? '' : 's'} ago`
      : `Filter change due in ${f.daysRemaining} day${f.daysRemaining === 1 ? '' : 's'}`,
    customerId: f.customer.id,
    actionLabel: 'View home',
  }));

  newSignups.forEach((o) => attention.push({
    id: `signup_${o.id}`,
    kind: 'new_signup',
    title: `${o.name} — new owner sign-up`,
    subtitle: `Created their own account ${o.createdAt.slice(0, 10)}`,
    ownerId: o.id,
    actionLabel: 'View owner',
  }));

  pendingRequests.forEach((r) => attention.push({
    id: `request_${r.id}`,
    kind: 'service_request',
    title: `${customerName(r.customerId)} — service request`,
    subtitle: `Requested ${r.requestedDate}`,
    customerId: r.customerId,
    serviceRequestId: r.id,
    actionLabel: 'Review',
  }));

  const teamStatus = technicians.map((t) => {
    const todaysEntries = timeEntries.filter((e) => e.technicianId === t.id && e.date === today);
    const clockedIn = todaysEntries.some((e) => e.clockInAt && !e.clockOutAt);
    const jobsToday = todaysJobs.filter((a) => a.technicianId === t.id);
    return {
      technicianId: t.id,
      name: t.name,
      clockedIn,
      jobsToday: jobsToday.length,
      jobsCompletedToday: jobsToday.filter((a) => a.status === 'completed').length,
    };
  });

  const briefing = await ai.generateDailyBriefing({
    jobCount: todaysJobs.length,
    overdueJobs: overdueJobs.slice(0, 5).map((a) => ({ customerName: a.customerName, daysOverdue: a.daysOverdue })),
    unpaidInvoices: unpaidInvoices.map((i) => ({ customerName: i.customerName, amount: i.amount })),
    predictiveFlags: filterFlags.slice(0, 3).map((f) => ({
      customerName: f.customer.name,
      reason: f.daysRemaining < 0 ? 'has an overdue filter change' : 'has a filter change due soon',
    })),
    newSignups: newSignups.map((o) => ({ name: o.name })),
  });

  res.json({
    date: today,
    jobCount: todaysJobs.length,
    briefing,
    attention,
    teamStatus,
    aiConfigured: ai.isConfigured(),
  });
});

module.exports = router;
