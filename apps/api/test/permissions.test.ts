import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, ROLES_BY_ORG_TYPE, can } from '../src/modules/identity/permissions';

describe('permission matrix (POC plan A-22)', () => {
  it('matches the agreed matrix exactly', () => {
    expect(PERMISSIONS).toMatchSnapshot();
  });
  it('Viewer is read-only', () => {
    expect(PERMISSIONS.Viewer).toEqual(['read']);
  });
  it('approving and creating are separated (maker-checker friendly)', () => {
    expect(can('FinanceUser', 'invoice:create')).toBe(true);
    expect(can('FinanceUser', 'invoice:accept')).toBe(false);
    expect(can('Approver', 'invoice:accept')).toBe(true);
    expect(can('Approver', 'invoice:create')).toBe(false);
  });
  it('every role is available in at least one organisation type', () => {
    for (const role of ROLES) {
      expect(Object.values(ROLES_BY_ORG_TYPE).some((rs) => rs.includes(role))).toBe(true);
    }
  });
});
