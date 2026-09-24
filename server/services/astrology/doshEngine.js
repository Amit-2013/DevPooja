/* Dosh analysis engine.

   The set of conditions and their metadata (name, description, default severity,
   enabled/disabled) live in the kundali_conditions table — admins control them.
   The astrological evaluation logic lives in rules/*.js, keyed by condition code.
   The engine combines both and returns structured, explainable results in BOTH
   languages: English fields are the source of truth (and the fallback), while
   nameHi / explanationHi / evidenceHi carry the Hindi presentation. The UI picks
   the language; the chart is analysed once. */
'use strict';
const { db } = require('../../db');
const rules = require('./rules');
const kundaliEngine = require('./kundaliEngine');

/* Evaluates every active condition that has a rule. Disabled conditions are skipped.
   view: analysisView(chart); now: Date for transit rules. */
function analyze(chart, { now } = {}) {
  const view = kundaliEngine.analysisView(chart);
  const conditions = db.prepare('SELECT * FROM kundali_conditions WHERE active=1').all();

  const results = [];
  for (const c of conditions) {
    const rule = rules[c.code];
    if (!rule) continue; /* a DB condition without a rule module: shown as "not evaluated" */
    let out = null;
    try {
      out = rule.evaluate(view, now || new Date(), chart.partner || null);
    } catch (e) {
      /* a broken rule must never break the whole analysis */
      console.error('[doshEngine] rule ' + c.code + ' failed:', e.message);
      continue;
    }
    if (!out) {
      results.push({
        code: c.code, name: c.name, nameHi: c.name_hi || '', detected: false, severity: 'none', confidence: null,
        explanation: c.descr || '', explanationHi: c.descr_hi || '', evidence: [], evidenceHi: [], remedies: []
      });
      continue;
    }
    results.push({
      code: c.code,
      name: c.name,
      nameHi: c.name_hi || '',
      detected: !!out.detected,
      severity: out.severity || 'low',
      confidence: out.confidence,
      explanation: c.descr || '',
      explanationHi: c.descr_hi || '',
      evidence: out.evidence || [],
      evidenceHi: out.evidenceHi || [],
      remedies: [],
      remedyHi: c.remedy_hi || ''
    });
  }
  return results;
}

/* Only the detected ones, sorted by severity. */
function detected(results) {
  const order = { high: 0, medium: 1, low: 2 };
  return results.filter((r) => r.detected).sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

module.exports = { analyze, detected };
