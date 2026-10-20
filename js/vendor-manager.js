/**
 * vendor-manager.js — vendor shortlist and booking state.
 *
 * Honesty rule baked into the data model: every vendor record carries a
 * `verification` field. CelebrAI has no business directory and no live
 * availability feed, so AI-suggested entries are permanently stamped
 * `unverified-suggestion` and the UI renders that stamp. A record only
 * becomes `user-confirmed` when the user says they contacted the vendor.
 */

import { toPaise } from './money.js';

export const VENDOR_CATEGORIES = [
  { id: 'venue', label: 'Venue' },
  { id: 'catering', label: 'Catering' },
  { id: 'photography', label: 'Photography & Video' },
  { id: 'decor', label: 'Decorations & Florals' },
  { id: 'transport', label: 'Transportation' },
  { id: 'music', label: 'Audio & Lighting' },
  { id: 'invitations', label: 'Invitations & Printing' },
  { id: 'other', label: 'Other Services' },
];

export const SHORTLIST_STATUSES = ['idea', 'shortlisted', 'quoted', 'rejected'];
export const BOOKING_STATUSES = ['not-contacted', 'enquired', 'negotiating', 'booked', 'cancelled'];
export const PAYMENT_STATUSES = ['unpaid', 'advance-paid', 'part-paid', 'fully-paid'];
export const VERIFICATION_LEVELS = ['unverified-suggestion', 'user-confirmed'];

let counter = 0;
function makeVendorId() {
  counter += 1;
  return `vendor-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Create a vendor record.
 * `quotedCost` is in rupees and converted to integer paise here.
 */
export function createVendor(input = {}) {
  const categoryId = VENDOR_CATEGORIES.some((c) => c.id === input.categoryId)
    ? input.categoryId
    : 'other';

  let quotedCostPaise = null;
  if (input.quotedCost !== '' && input.quotedCost !== null && input.quotedCost !== undefined) {
    quotedCostPaise = toPaise(input.quotedCost); // throws on negative/invalid
  }

  return {
    id: input.id || makeVendorId(),
    name: String(input.name ?? '').trim().slice(0, 120) || 'Unnamed vendor',
    categoryId,
    shortlistStatus: SHORTLIST_STATUSES.includes(input.shortlistStatus) ? input.shortlistStatus : 'idea',
    bookingStatus: BOOKING_STATUSES.includes(input.bookingStatus) ? input.bookingStatus : 'not-contacted',
    paymentStatus: PAYMENT_STATUSES.includes(input.paymentStatus) ? input.paymentStatus : 'unpaid',
    quotedCostPaise,
    notes: String(input.notes ?? '').slice(0, 1000),
    contact: String(input.contact ?? '').slice(0, 160),
    verification: input.verification === 'user-confirmed' ? 'user-confirmed' : 'unverified-suggestion',
    source: input.source === 'ai-suggested' ? 'ai-suggested' : 'user',
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function updateVendor(vendors, vendorId, patch = {}) {
  return vendors.map((v) => {
    if (v.id !== vendorId) return v;
    const next = { ...v };
    if ('name' in patch) next.name = String(patch.name).trim().slice(0, 120) || v.name;
    if ('categoryId' in patch && VENDOR_CATEGORIES.some((c) => c.id === patch.categoryId)) {
      next.categoryId = patch.categoryId;
    }
    if ('shortlistStatus' in patch) {
      if (!SHORTLIST_STATUSES.includes(patch.shortlistStatus)) {
        throw new RangeError(`Unknown shortlist status: ${patch.shortlistStatus}`);
      }
      next.shortlistStatus = patch.shortlistStatus;
    }
    if ('bookingStatus' in patch) {
      if (!BOOKING_STATUSES.includes(patch.bookingStatus)) {
        throw new RangeError(`Unknown booking status: ${patch.bookingStatus}`);
      }
      next.bookingStatus = patch.bookingStatus;
    }
    if ('paymentStatus' in patch) {
      if (!PAYMENT_STATUSES.includes(patch.paymentStatus)) {
        throw new RangeError(`Unknown payment status: ${patch.paymentStatus}`);
      }
      next.paymentStatus = patch.paymentStatus;
    }
    if ('quotedCost' in patch) {
      next.quotedCostPaise = patch.quotedCost === '' || patch.quotedCost === null
        ? null
        : toPaise(patch.quotedCost);
    }
    if ('notes' in patch) next.notes = String(patch.notes).slice(0, 1000);
    if ('contact' in patch) next.contact = String(patch.contact).slice(0, 160);
    if ('verification' in patch && VERIFICATION_LEVELS.includes(patch.verification)) {
      next.verification = patch.verification;
    }
    return next;
  });
}

export function removeVendor(vendors, vendorId) {
  return vendors.filter((v) => v.id !== vendorId);
}

/**
 * Turn booked/quoted vendors into budget expenses.
 * Booked vendors become `actual` commitments; quoted ones stay `estimate`.
 */
export function vendorsToExpenses(vendors) {
  const expenses = [];
  for (const v of vendors) {
    if (v.quotedCostPaise === null || v.quotedCostPaise === undefined) continue;
    if (v.bookingStatus === 'cancelled' || v.shortlistStatus === 'rejected') continue;
    expenses.push({
      categoryId: v.categoryId,
      amountPaise: v.quotedCostPaise,
      kind: v.bookingStatus === 'booked' ? 'actual' : 'estimate',
      sourceVendorId: v.id,
    });
  }
  return expenses;
}

export function vendorCoverage(vendors, requiredCategoryIds = []) {
  const booked = new Set(vendors.filter((v) => v.bookingStatus === 'booked').map((v) => v.categoryId));
  const touched = new Set(vendors.map((v) => v.categoryId));
  return requiredCategoryIds.map((id) => ({
    categoryId: id,
    label: VENDOR_CATEGORIES.find((c) => c.id === id)?.label ?? id,
    booked: booked.has(id),
    started: touched.has(id),
  }));
}

export function vendorSummary(vendors) {
  return {
    total: vendors.length,
    shortlisted: vendors.filter((v) => v.shortlistStatus === 'shortlisted').length,
    booked: vendors.filter((v) => v.bookingStatus === 'booked').length,
    unverified: vendors.filter((v) => v.verification === 'unverified-suggestion').length,
    fullyPaid: vendors.filter((v) => v.paymentStatus === 'fully-paid').length,
  };
}
