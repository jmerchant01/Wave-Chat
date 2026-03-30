const mongoose = require('mongoose');

// Singleton document — only ever one row
const waveSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },

  // % cut of every subscriber payment (0–100)
  subscriptionFeePercent: { type: Number, default: 10, min: 0, max: 100 },

  // Monthly flat fee (in cents) charged to communities that enable paid subscriptions
  // 0 = disabled
  communityFlatFeeMonthly: { type: Number, default: 0, min: 0 },

  // One-time setup/activation fee (in cents) when a creator first enables paid subscriptions
  communitySetupFee: { type: Number, default: 0, min: 0 },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: 'system' }
});

waveSettingsSchema.statics.get = async function(){
  let s = await this.findOne({ key: 'global' });
  if(!s) s = await this.create({ key: 'global' });
  return s;
};

module.exports = mongoose.model('WaveSettings', waveSettingsSchema);
