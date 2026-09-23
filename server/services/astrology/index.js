/* Facade for the astrology service layer. The route file should only use this. */
'use strict';

module.exports = {
  ephemeris: require('./ephemeris'),
  kundali: require('./kundaliEngine'),
  dosh: require('./doshEngine'),
  recommend: require('./recommendationEngine')
};
