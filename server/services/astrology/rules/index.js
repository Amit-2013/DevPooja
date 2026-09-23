/* Registry of condition rules. Adding a new dosh: create a rule module here,
   register it below, and add a kundali_conditions row (see migrations or the
   admin panel). Rules are pure functions: view -> {detected,severity,confidence,evidence}. */
'use strict';

module.exports = {
  mangal_dosha: require('./mangalDosh'),
  kaal_sarp: require('./kaalSarpDosh'),
  pitru_dosha: require('./pitruDosh'),
  nadi_dosha: require('./nadiDosh'),
  grahan_dosha: require('./grahanDosh'),
  guru_chandal: require('./guruChandalYoga'),
  shani_condition: require('./shaniConditions'),
  rahu_condition: require('./rahuConditions'),
  ketu_condition: require('./ketuConditions')
};
