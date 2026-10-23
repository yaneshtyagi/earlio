import { describe, expect, it } from 'vitest';
import { formatMoney } from './money';
import { navFor } from './nav';

describe('formatMoney', () => {
  it('uses Indian grouping for INR', () => {
    expect(formatMoney('8725345', 'INR')).toBe('₹87,25,345.00');
    expect(formatMoney(1234, 'INR')).toBe('₹1,234.00');
    expect(formatMoney('88827.52', 'INR')).toBe('₹88,827.52');
  });
  it('uses western grouping for USD and SGD', () => {
    expect(formatMoney('100000', 'USD')).toBe('USD 100,000.00');
    expect(formatMoney('22500', 'SGD')).toBe('SGD 22,500.00');
  });
});

describe('navFor', () => {
  it('hides items the role cannot use', () => {
    expect(navFor('platform', ['read']).map((i) => i.to)).toEqual(['/']);
    expect(navFor('platform', ['read', 'audit:read']).map((i) => i.to)).toContain('/audit');
  });
});
