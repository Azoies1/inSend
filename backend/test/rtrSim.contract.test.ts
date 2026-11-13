import { cents } from '../src/money';
import { runAdapterContract } from './contract/adapterContract';
import { RTR_SANDBOX_TRIGGERS, buildAdapter, payee, triggerPayee } from './rtr/helpers';
import { replayTransport } from './rtr/fixtures';

// The shared contract, unchanged, against RTRSimAdapter replaying recorded sandbox responses.
runAdapterContract({
  adapterName: 'RTRSimAdapter (recorded sandbox fixtures)',
  async create() {
    const { adapter } = buildAdapter(replayTransport().transport);
    return {
      provider: adapter,
      async scenario(outcome) {
        return {
          payee:
            outcome === 'SETTLED'
              ? payee()
              : triggerPayee(RTR_SANDBOX_TRIGGERS.REJECTED_SETTLEMENT_ABORTED),
          amountCents: cents(185000),
        };
      },
      async badSignatureWebhook(paymentId, state) {
        return {
          rawBody: Buffer.from(JSON.stringify({ paymentId, state })),
          headers: { 'x-jws-signature': 'not-a-valid-signature' },
        };
      },
    };
  },
});
