import { cents } from '../src/money';
import { FakeAdapter } from '../src/payments/adapters/fake/FakeAdapter';
import type { CreatePayeeInput } from '../src/payments/provider';
import { runAdapterContract, type ContractScenario } from './contract/adapterContract';

// Synthetic payee. Not a real person or account.
const payee: CreatePayeeInput = {
  name: 'Synthetic Landlord One',
  account: { institutionNumber: '999', transitNumber: '00000', accountNumber: '0000001' },
};
const scenario: ContractScenario = { payee, amountCents: cents(185000) };

runAdapterContract({
  adapterName: 'FakeAdapter',
  async create() {
    const fake = new FakeAdapter();
    return {
      provider: fake,
      async scenario(outcome) {
        fake.planNext({ state: outcome });
        return scenario;
      },
      async pendingScenario() {
        fake.planNext({ state: 'PENDING' });
        return scenario;
      },
      async badSignatureWebhook(paymentId, state) {
        return fake.buildWebhook(paymentId, state, { secret: 'not-the-secret' });
      },
      async validWebhook(paymentId, state) {
        return fake.buildWebhook(paymentId, state);
      },
    };
  },
});
