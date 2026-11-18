/** Builds a realistic Meta WhatsApp Cloud API webhook payload for testing. */
export function buildTestWebhookPayload(now: number, body?: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-TEST",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "920000000000",
                phone_number_id: "TEST-PHONE-ID",
              },
              contacts: [
                { profile: { name: "Ahmed Traders" }, wa_id: "923211234501" },
              ],
              messages: [
                {
                  from: "923211234501",
                  id: `test-${now}`,
                  timestamp: String(Math.floor(now / 1000)),
                  type: "text",
                  text: {
                    body:
                      body ??
                      "Ahmed Traders\nBill #9001\n5 bags cement @ 1480\nTotal 7400 udhaar",
                  },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  });
}
