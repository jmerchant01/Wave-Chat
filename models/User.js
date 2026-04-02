const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 24 },
  email:    { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  avatar:   { type: String, default: null },
  pushSubscription: { type: Object, default: null }, // Web Push subscription object
  isVerified: { type: Boolean, default: false },        // Admin-verified user (blue checkmark)
  verifiedAt:  { type: Date, default: null },
  verifiedBy:  { type: String, default: null },         // admin username who verified
  verificationNote: { type: String, default: '' },      // e.g. "Public figure", "Content creator"
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // users this user has blocked
  notificationPrefs: {
    friendOnline:    { type: Boolean, default: true },
    friendRequest:   { type: Boolean, default: true },
    directMessage:   { type: Boolean, default: true },
    communityInvite: { type: Boolean, default: true },
    roomInvite:      { type: Boolean, default: true },
    communityMessage:{ type: Boolean, default: false },
  },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [{
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
  }],
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
