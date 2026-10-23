import { D, formatMoney } from '../../kernel/money';

/** Hindi notification templates for the supplier-critical events. Topics without a Hindi template fall back to English. */
const h = (p: any) => p.humanId ?? 'इनवॉइस';
const inr = (v: unknown) => { try { return formatMoney(D(String(v).replace(/,/g, '')), 'INR'); } catch { return `₹${v}`; } };
const ccy = (p: any, k = 'amount') => `${p.currency ?? ''} ${p[k] ?? ''}`.trim();
type Tpl = { subject: (p: any) => string; body: (p: any) => string };
export const HI: Record<string, Tpl> = {
  'invoice.submitted': { subject: (p) => `इनवॉइस ${h(p)} स्वीकृति की प्रतीक्षा में`, body: (p) => `इनवॉइस ${h(p)} जमा हो गया है और खरीदार की स्वीकृति का इंतज़ार है।` },
  'invoice.accepted': { subject: (p) => `इनवॉइस ${h(p)} स्वीकृत`, body: (p) => `खरीदार ने इनवॉइस ${h(p)} स्वीकार कर लिया है। अब आप जल्दी भुगतान या वित्तपोषण माँग सकते हैं।` },
  'invoice.rejected': { subject: (p) => `इनवॉइस ${h(p)} अस्वीकृत`, body: (p) => `खरीदार ने इनवॉइस ${h(p)} अस्वीकार कर दिया।` },
  'invoice.overdue': { subject: (p) => `इनवॉइस ${h(p)} की देय तिथि निकल गई`, body: (p) => `इनवॉइस ${h(p)} का भुगतान देय तिथि तक नहीं हुआ।` },
  'offer.submitted': { subject: (p) => `${h(p)} पर नया ऑफ़र`, body: (p) => `एक बैंक ने ${h(p)} पर ऑफ़र भेजा है। कृपया तुलना करके चुनें।` },
  'financing.approved': { subject: (p) => `${h(p)} का वित्तपोषण मंज़ूर`, body: (p) => `बैंक ने ${h(p)} का वित्तपोषण मंज़ूर कर दिया है। भुगतान की तैयारी चल रही है।` },
  'financing.funded': { subject: (p) => `${h(p)} का वित्तपोषण पूरा`, body: (p) => `${h(p)} का वित्तपोषण पूरा हो गया है।` },
  'disbursement.credited': { subject: (p) => `${h(p)} के लिए ${inr(p.amountInr)} जमा हुए`, body: (p) => `${h(p)} के लिए ${inr(p.amountInr)} आपके खाते में जमा कर दिए गए हैं।` },
  'disbursement.reversed': { subject: (p) => `${h(p)} का भुगतान विफल`, body: (p) => `${h(p)} का भुगतान विफल रहा और वापस हो गया: ${p.reason ?? ''}` },
  'settlement.payment_due': { subject: (p) => `${h(p)} का भुगतान देय`, body: (p) => `${p.dueDate} तक संदर्भ ${p.reference} के साथ ${ccy(p)} का भुगतान करें।` },
  'settlement.distributed': { subject: (p) => `${h(p)} का भुगतान वितरित`, body: (p) => `खरीदार का भुगतान वितरित हो गया है (बैंक ${p.toBank}, आपकी रोकी गई राशि ${p.retention} ${p.currency}).` },
  'dispute.raised': { subject: (p) => `${h(p)} पर विवाद दर्ज`, body: (p) => `${h(p)} पर विवाद दर्ज हुआ है। समाधान होने तक इनवॉइस रुका रहेगा।` },
  'dispute.resolved': { subject: () => 'विवाद का निपटारा हुआ', body: (p) => `विवाद का निपटारा हो गया: ${String(p.outcome).replace(/_/g, ' ')}।` },
  'recourse.created': { subject: (p) => `${h(p)} पर बैंक को देय राशि`, body: (p) => `बैंक को ${p.amount} ${p.currency} देय है।${p.small ? ' आप हर भुगतान के अधिकतम 20% के समायोजन से या 90 दिन की किस्तों में चुका सकते हैं; कोई दंड ब्याज नहीं।' : ''}` },
  'dunning.notice': { subject: (p) => `${h(p)} के लिए भुगतान अनुस्मारक ${p.level}`, body: (p) => `${h(p)} ${p.daysOverdue} दिन से अतिदेय है। अब तक विलंब ब्याज: ${p.lateInterest} ${p.currency}।` },
  'export_proceeds.overdue': { subject: (p) => `${h(p)} की निर्यात आय अतिदेय`, body: (p) => `${h(p)} की आय ${p.deadline} तक आनी थी। कृपया अपने अधिकृत डीलर बैंक से बात करें।` },
  'claim.paid': { subject: (p) => `${h(p)} का दावा भुगतान`, body: (p) => `बीमाकर्ता ने ${p.payout} ${p.currency} चुकाए: ${p.toBank} बैंक को, ${p.toSupplier} आपकी रोकी गई राशि में।` },
};
