# Read an existing job without submitting work

1. Through proxied bash with the FlashData credential ID, GET `https://api.flashdata.dev/v2/jobs/<job-id>`. Validate `job.source` against this skill's source. Read `job.status`; pending/processing is not complete.
2. For a completed job, GET `https://api.flashdata.dev/v2/api-access` through the same proxy and retain the trusted `result_origin`.
3. GET `https://api.flashdata.dev/v2/jobs/<job-id>/results` through the same proxy, without following redirects. A successful response is HTTP 302 with a signed result URL in Location. This endpoint does not return the result JSON inline.
4. Validate the URL: HTTPS, exact origin equality with `result_origin`, no user-info or fragment. If invalid or missing, stop. Fetch that URL separately with NO FlashData credential ID or API-key header and NO redirect following. Keep the signed URL private.
5. The fetched JSON is the original response. Read `results`; for a download, `results[0]` contains the delivery manifest. The MCP `get_job` tool combines these steps and wraps the fetched JSON in `output`; the raw Jobs API does not.
6. JSON results expire after 24 hours. A failed/expired result read does not authorize resubmission. Private delivered media and retention remain controlled by the user's storage.
