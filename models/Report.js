const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  // Who filed the report
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // What type of content is being reported
  targetType: {
    type: String,
    enum: ['user', 'community', 'message', 'community_message', 'room', 'screenshare', 'camera'],
    required: true
  },

  // References — only the relevant ones will be populated
  reportedUser:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reportedCommunity: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
  reportedMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  reportedCommunityMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityMessage', default: null },
  roomId:      { type: String, default: null },  // for voice room reports
  roomName:    { type: String, default: null },

  // Snapshot of reported content (in case it gets deleted)
  contentSnapshot: { type: String, default: null },

  reason: {
    type: String,
    enum: [
      'harassment', 'hate_speech', 'spam', 'inappropriate_content',
      'impersonation', 'threats', 'illegal_content', 'csam',
      'self_harm', 'violence', 'fraud', 'external_payment_solicitation', 'other'
    ],
    required: true
  },
  description: { type: String, required: true, minlength: 5, maxlength: 1000 },
  status: { type: String, enum: ['pending', 'reviewed', 'actioned', 'dismissed'], default: 'pending' },
  adminNote: { type: String, default: '' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  createdAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: null }
});

// Auto-elevate priority for severe reasons
reportSchema.pre('save', function(next) {
  if(['csam','threats','illegal_content','violence'].includes(this.reason)){
    this.priority = 'critical';
  } else if(['hate_speech','self_harm','fraud'].includes(this.reason)){
    this.priority = 'high';
  }
  next();
});

reportSchema.index({ status: 1, priority: -1, createdAt: -1 });
reportSchema.index({ reportedBy: 1 });

module.exports = mongoose.model('Report', reportSchema);
