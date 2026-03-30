const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  communityId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
  // Stripe IDs
  stripeCustomerId:       { type: String, default: null },
  stripeSubscriptionId:   { type: String, default: null },  // null for lifetime
  stripePaymentIntentId:  { type: String, default: null },  // for lifetime one-time
  // Plan details
  plan:     { type: String, enum: ['weekly','monthly','yearly','lifetime'], required: true },
  status:   { type: String, enum: ['active','canceled','past_due','trialing','incomplete'], default: 'active' },
  // Pricing
  amount:       { type: Number, required: true },  // in cents
  currency:     { type: String, default: 'usd' },
  // Dates
  currentPeriodStart: { type: Date },
  currentPeriodEnd:   { type: Date },
  canceledAt:         { type: Date, default: null },
  createdAt:          { type: Date, default: Date.now }
});

subscriptionSchema.index({ userId: 1, communityId: 1 });
subscriptionSchema.index({ stripeSubscriptionId: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
