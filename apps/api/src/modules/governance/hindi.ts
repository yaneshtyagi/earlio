/** Hindi plain-language summary of a terms body, generated from the same structure as the English preview (CT-8). */
const TIERS: Record<string, string> = { AAA: 'AAA', AA: 'AA', A: 'A', BBB: 'BBB', BB: 'BB', B: 'B' };
const tier = (m: Record<string, number> | undefined) => Object.entries(m ?? {}).map(([k, v]) => `${TIERS[k] ?? k}: ${v}%`).join(', ');
const money = (n: number) => Number(n).toLocaleString('en-US');
const word = (s: string) => s.replace(/_/g, ' ');
export interface PreviewHi { supplier: string[]; buyer: string[]; notes: string[] }

export function describeTermsHi(owner: 'platform' | 'bank' | 'insurer', b: Record<string, any>, benchmarkPct = 4.1): PreviewHi {
  const p: PreviewHi = { supplier: [], buyer: [], notes: [] };
  if (owner === 'bank') {
    if (b.advancePct != null) p.supplier.push(`आपको इनवॉइस का ${b.advancePct}% तक अग्रिम रुपयों में मिलता है; बाकी (शुल्क घटाकर) खरीदार के भुगतान करने पर मिलता है।`);
    if (b.pricing?.type === 'fixed') p.supplier.push(`जितने दिन पैसा बाहर रहता है, उसके लिए आप ${b.pricing.ratePct}% वार्षिक देते हैं।`);
    else if (b.pricing?.type === 'benchmark') p.supplier.push(`आप बेंचमार्क दर (आज ${benchmarkPct}%) और खरीदार की रेटिंग पर निर्भर मार्जिन देते हैं — ${tier(b.pricing.spreadPctByTier)}।`);
    if (b.processingFee) p.supplier.push(`${b.processingFee.pct}% प्रोसेसिंग शुल्क लगता है${b.processingFee.minUsd ? ` (कम से कम USD ${b.processingFee.minUsd})` : ''}।`);
    if (b.fxSpreadPct != null) p.supplier.push(`डॉलर को बाज़ार दर से ${b.fxSpreadPct}% कम पर रुपयों में बदला जाता है।`);
    if (b.invoiceSizeUsd) p.supplier.push(`इनवॉइस USD ${money(b.invoiceSizeUsd.min)} से USD ${money(b.invoiceSizeUsd.max)} तक, अधिकतम ${b.maxTenorDays} दिन, ${(b.currencies ?? []).join(' या ')} मुद्रा में, ${(b.buyerCountries ?? []).join(' या ')} के खरीदारों के लिए।`);
    if (b.cutoff) p.supplier.push(`यदि वित्तपोषण ${b.cutoff.time} (${b.cutoff.timezone}) से पहले पुष्ट हो जाए तो पैसा उसी बैंकिंग दिन भेजा जाता है, अन्यथा अगले बैंकिंग दिन${b.settlementDays ? `, साथ में ${b.settlementDays} निपटान दिन` : ''}।`);
    if (b.offerValidityHours) p.supplier.push(`हर ऑफ़र ${b.offerValidityHours} घंटे तक खुला रहता है।`);
    if (b.minCoverPct != null) p.supplier.push(`बैंक केवल वही इनवॉइस वित्तपोषित करता है जिनमें बीमा कम से कम ${b.minCoverPct}% कवर करे।`);
    if (b.requiredDocuments?.length) p.supplier.push(`आपको ये संलग्न करने होंगे: ${b.requiredDocuments.map(word).join(', ')}।`);
    for (const f of b.customFields ?? []) if (f.appliesTo === 'financing_request') p.supplier.push(`बैंक पूछता है: "${f.label}"${f.required ? ' (अनिवार्य)' : ''}।`);
    p.buyer.push('आप इनवॉइस, अपना भुगतान वचन और जिस बैंक को भुगतान करना है, वह देखते हैं। आप दर, शुल्क या आपूर्तिकर्ता की शुद्ध नकदी नहीं देखते।');
    if (b.graceDays) p.buyer.push(`देय तिथि के ${b.graceDays} दिन बाद तक का भुगतान विलंबित नहीं माना जाता।`);
    if (b.platformFeePayer) p.notes.push(`Earlio प्लेटफ़ॉर्म शुल्क ${b.platformFeePayer === 'supplier' ? 'आपूर्तिकर्ता' : b.platformFeePayer === 'buyer' ? 'खरीदार' : b.platformFeePayer} देता है।`);
  } else if (owner === 'insurer') {
    if (b.coverPct != null) p.supplier.push(`इनवॉइस के मूल्य का ${b.coverPct}% बीमित है।`);
    if (b.premium?.mode === 'flat') p.supplier.push(`प्रीमियम इनवॉइस का ${b.premium.flatRatePct}% है।`);
    else if (b.premium?.mode === 'per_period') p.supplier.push(`प्रीमियम हर ${b.premium.periodDays} दिन की अवधि पर खरीदार की रेटिंग के अनुसार लगता है (${tier(b.premium.ratePctByTier)})।`);
    if (b.waitingPeriodDays) p.supplier.push(`यदि खरीदार भुगतान नहीं करता, तो ${b.waitingPeriodDays.protractedDefault} दिन बाद दावा खुलता है; दिवालिया होने पर ${b.waitingPeriodDays.insolvency === 0 ? 'तुरंत' : `${b.waitingPeriodDays.insolvency} दिन बाद`}।`);
    if (b.exclusions?.length) p.supplier.push(`इन पर कवर नहीं: ${b.exclusions.map(word).join(', ')}।`);
    if (b.claimDeadlineDays) p.supplier.push(`प्रतीक्षा अवधि के बाद बैंक को ${b.claimDeadlineDays} दिन में दावा करना होगा।`);
    p.buyer.push('बीमा बैंक और आपूर्तिकर्ता की रक्षा करता है; इससे आपका देय या उसकी तारीख नहीं बदलती।');
  } else {
    if (b.disputeWindowHours != null) p.buyer.push(`इनवॉइस स्वीकार करने के बाद वित्तपोषण से पहले विवाद उठाने के लिए आपके पास ${b.disputeWindowHours} घंटे हैं।`);
    if (b.platformFee) p.notes.push(`प्लेटफ़ॉर्म शुल्क: ${b.platformFee.bps} बेसिस पॉइंट।`);
    if (b.freeTierInvoicesPerMonth != null) p.supplier.push(`छोटे आपूर्तिकर्ता हर महीने ${b.freeTierInvoicesPerMonth} इनवॉइस बिना प्लेटफ़ॉर्म शुल्क के वित्तपोषित कर सकते हैं।`);
    if (b.maxAllInCostSmallPct != null) p.supplier.push(`छोटे आपूर्तिकर्ताओं को ${b.maxAllInCostSmallPct}% वार्षिक से अधिक कुल लागत का ऑफ़र कभी नहीं मिलता।`);
    if (b.maxFxSpreadPct != null) p.supplier.push(`कोई भी बैंक बाज़ार FX दर से ${b.maxFxSpreadPct}% से अधिक नहीं ले सकता।`);
  }
  return p;
}
