const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:    { type: String, default: '' },
  fileUrl: { type: String, default: null },   // base64 data URL
  fileType:{ type: String, default: null },   // 'image', 'video', 'file'
  fileName:{ type: String, default: null },
  read:    { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Index for fast conversation lookup
messageSchema.index({ from: 1, to: 1, createdAt: -1 });
messageSchema.index({ to: 1, read: 1 });

module.exports = mongoose.model('Message', messageSchema);
