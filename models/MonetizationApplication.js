const mongoose = require('mongoose');

const monetizationApplicationSchema = new mongoose.Schema({
  communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
  ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // What the creator wants to charge
  proposedPricing: {
    weekly:   { type: Number, default: 0 },  // in dollars
    monthly:  { type: Number, default: 0 },
    yearly:   { type: Number, default: 0 },
    lifetime: { type: Number, default: 0 }
  },

  // Creator's explanation of what subscribers get
  valueProposition: { type: String, required: true, maxlength: 1000 },

  // Has the creator connected Stripe?
  stripeAccountId: { type: String, default: null },

  // Admin review
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'revoked'],
    default: 'pending'
  },
  adminNote:   { type: String, default: '' },
  reviewedBy:  { type: String, default: null },
  reviewedAt:  { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

monetizationApplicationSchema.index({ status: 1, createdAt: -1 });
monetizationApplicationSchema.index({ communityId: 1 }, { unique: true });
monetizationApplicationSchema.index({ ownerId: 1 });

module.exports = mongoose.model('MonetizationApplication', monetizationApplicationSchema);
