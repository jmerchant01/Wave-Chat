const mongoose = require('mongoose');

const communityMessageSchema = new mongoose.Schema({
  communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
  channelId:   { type: String, required: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:        { type: String, default: '' },
  fileUrl:     { type: String, default: null },
  fileType:    { type: String, default: null },
  fileName:    { type: String, default: null },
  deleted:     { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
});

communityMessageSchema.index({ communityId: 1, channelId: 1, createdAt: -1 });

module.exports = mongoose.model('CommunityMessage', communityMessageSchema);
