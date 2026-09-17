# D1 and R2 recovery

Use Cloudflare D1 Time Travel/backup capabilities for relational state and R2
object versioning or retained export manifests for files. Restore into isolated
replacement resources first; never overwrite the affected production resource.

Recovery procedure:

1. Record the incident time and stop unsafe writes if required.
2. Create isolated replacement D1/R2 targets.
3. Restore the selected D1 point and verify migration state, counts, tenant
   relationships, and representative values.
4. Verify every R2 artifact against its stored byte count and digest.
5. Run authentication, authorization, CRUD, attachment, Queue, and Workflow
   smoke tests against the isolated targets.
6. Change bindings through the reviewed deployment and retain the originals
   until incident closure.
