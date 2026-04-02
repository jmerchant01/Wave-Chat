const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  targetType: {
    type: String,
    enum: ['user', 'community', 'room'],
    required: true
  },

  // Only one of these will be set depending on targetType
  blockedUser:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  blockedCommunity: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
  blockedRoomId:    { type: String, default: null },
  blockedRoomName:  { type: String, default: null },

  createdAt: { type: Date, default: Date.now }
});

blockSchema.index({ blockedBy: 1, targetType: 1 });
blockSchema.index({ blockedBy: 1, blockedUser: 1 }, { unique: true, sparse: true });
blockSchema.index({ blockedBy: 1, blockedCommunity: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Block', blockSchema);
