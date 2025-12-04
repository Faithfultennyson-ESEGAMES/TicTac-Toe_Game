Dead Letter Queue (DLQ) Admin API Documentation
The DLQ Admin API provides secure access to inspect, resend, and delete webhook events that failed delivery and were moved into the Dead Letter Queue.

🔐 Authentication
All DLQ endpoints are protected by a password defined in your .env file:
DLQ_PASSWORD=hasdhasidba8dhqa9podhasudygadfaf


Requests must include this password in the Authorization header:
Authorization: Bearer hasdhasidba8dhqa9podhasudygadfaf


⚠️ For the DELETE endpoint, the password must also be included in the request body.

📋 Endpoints
1. List all DLQ items
GET /admin/dlq
Returns an array of DLQ item IDs currently stored.
Headers:
Authorization: Bearer <DLQ_PASSWORD>


Response:
[
  "5772421c-db69-444b-858f-180e1bcf812c",
  "4f52019a-d612-4c9f-90bf-70c92f0d686f"
]



2. Inspect a single DLQ item
GET /admin/dlq/:id
Retrieves full details of a specific DLQ item.
Headers:
Authorization: Bearer <DLQ_PASSWORD>


Response:
{
  "dlq_item_id": "5772421c-db69-444b-858f-180e1bcf812c",
  "failed_at": "2025-12-04T16:27:48.457Z",
  "reason": "Exhausted 3 retry attempts.",
  "endpoint": "http://localhost:4001/bad-endpoint",
  "last_response_status": null,
  "delivery_attempts": [
    {
      "attempt_id": "d733520d-7a46-41ae-8f1a-ad723b564c97",
      "timestamp": "2025-12-04T16:27:28.424Z",
      "status_code": null,
      "error": "fetch failed"
    }
  ],
  "webhook_payload": {
    "event_id": "25d08945-a54e-427b-9627-6b99b50b703f",
    "event_type": "player.joined",
    "session_id": "d29f3b22-b84a-4b4c-9c0f-3509bea3ea44",
    "body": {
      "player_id": "p2",
      "player_name": "Bob",
      "status": "joined"
    }
  }
}



3. Resend a DLQ item
POST /admin/dlq/:id/resend
Attempts to resend the webhook event for the specified DLQ item.
Headers:
Authorization: Bearer <DLQ_PASSWORD>


Response (success):
{ "message": "DLQ item successfully resent and removed." }


Response (failure):
{ "error": "Failed to resend DLQ item. It remains in the DLQ." }



4. Delete all DLQ items
DELETE /admin/dlq
Deletes all DLQ items. Requires both header and body authentication.
Headers:
Authorization: Bearer <DLQ_PASSWORD>
Content-Type: application/json


Body:
{
  "password": "<DLQ_PASSWORD>"
}


Response:
{ "message": "Successfully deleted 14 items from the DLQ." }



🧪 Example Requests
Curl
# List DLQ items
curl -H "Authorization: Bearer hasdhasidba8dhqa9podhasudygadfaf" http://localhost:5500/admin/dlq

# Inspect DLQ item
curl -H "Authorization: Bearer hasdhasidba8dhqa9podhasudygadfaf" http://localhost:5500/admin/dlq/<DLQ_ID>

# Resend DLQ item
curl -X POST -H "Authorization: Bearer hasdhasidba8dhqa9podhasudygadfaf" http://localhost:5500/admin/dlq/<DLQ_ID>/resend

# Delete all DLQ items
curl -X DELETE \
  -H "Authorization: Bearer hasdhasidba8dhqa9podhasudygadfaf" \
  -H "Content-Type: application/json" \
  -d '{"password":"hasdhasidba8dhqa9podhasudygadfaf"}' \
  http://localhost:5500/admin/dlq
