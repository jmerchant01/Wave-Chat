const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  order: { type: Number, default: 0 },
  collapsed: { type: Boolean, default: false }
});

const channelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['text', 'voice', 'announcement', 'room'], default: 'text' },
  description: { type: String, default: '' },
  order: { type: Number, default: 0 },
  categoryId: { type: String, default: null }, // null = uncategorized
  permissions: [{ roleId: String, canRead: Boolean, canWrite: Boolean }],
  locked: { type: Boolean, default: false },
  chatLocked: { type: Boolean, default: false },
  activeRoomId: { type: String, default: null }
});

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  color: { type: String, default: '#6c63ff' },
  permissions: {
    canInvite:     { type: Boolean, default: true },
    canKick:       { type: Boolean, default: false },
    canBan:        { type: Boolean, default: false },
    canManageChannels: { type: Boolean, default: false },
    canManageRoles:    { type: Boolean, default: false },
    isAdmin:       { type: Boolean, default: false }
  },
  order: { type: Number, default: 0 }
});

const memberSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roles:    [{ type: String }], // role IDs
  nickname: { type: String, default: '' },
  joinedAt: { type: Date, default: Date.now },
  banned:   { type: Boolean, default: false }
});

const communitySchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 64 },
  description: { type: String, default: '', maxlength: 500 },
  avatar:      { type: String, default: null },
  banner:      { type: String, default: null },
  isPublic:    { type: Boolean, default: true },
  tags:        [{ type: String, lowercase: true, trim: true }],
  ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roles:       [roleSchema],
  categories:  [categorySchema],
  channels:    [channelSchema],
  members:     [memberSchema],
  inviteCode:  { type: String, unique: true, sparse: true },
  // Subscription / monetization
  isPaid:      { type: Boolean, default: false },
  subscription: {
    weekly:   { price: { type: Number, default: 0 }, stripePriceId: { type: String, default: null } },
    monthly:  { price: { type: Number, default: 0 }, stripePriceId: { type: String, default: null } },
    yearly:   { price: { type: Number, default: 0 }, stripePriceId: { type: String, default: null } },
    lifetime: { price: { type: Number, default: 0 }, stripePriceId: { type: String, default: null } },
  },
  stripeProductId: { type: String, default: null },
  // WAVE platform fee (percentage, 0-100)
  platformFeePercent: { type: Number, default: 10 },
  // Creator's Stripe Connect account
  stripeAccountId: { type: String, default: null },
  createdAt:   { type: Date, default: Date.now }
});

// Text index for search
communitySchema.index({ name: 'text', description: 'text', tags: 'text' });

module.exports = mongoose.model('Community', communitySchema);
