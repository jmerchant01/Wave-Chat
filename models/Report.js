const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reportedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: {
    type: String,
    enum: ['harassment', 'hate_speech', 'spam', 'inappropriate_content', 'impersonation', 'threats', 'other'],
    required: true
  },
  description: { type: String, required: true, minlength: 10, maxlength: 500 },
  status: { type: String, enum: ['pending', 'reviewed', 'dismissed'], default: 'pending' },
  adminNote: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Report', reportSchema);
