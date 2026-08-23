*Originally recorded as ADR 0006 in the DocVault repository, which this repository replaces. Renumbered as the first decision of a new chain; the reasoning is unchanged.*

# paperless-ngx replaces DocVault, and the differentiators become satellites

DocVault was built from scratch without ever recording why an existing document management system was not used. Five ADRs justify decisions inside the system; none justifies the system. This ADR closes that gap and answers the question in the other direction: the archive moves to paperless-ngx, and the parts of DocVault worth keeping become services around it rather than inside it.

**Four claims were tested, and none survived.** The build was defensible only if its differentiators were real requirements. They were examined one at a time.

*Private spaces that admins cannot read* (ADR 0003) is the strongest of them and the first to fall. The protection is a SQL predicate in `acl.service.ts`, not cryptography. Whoever operates the NAS reads the database directly, and `STORAGE_ENCRYPTION_KEY` sits in the backend environment. In a household the administrator, the machine operator and the person a private space guards against are the same human, so the rule documents an intention rather than enforcing a boundary. It is worth having where those roles are held by different people. Here they are not.

*Maintenance capacity* decided the rest. Roughly 11,900 lines of backend TypeScript, plus a Python worker and a React frontend, rest on about 1,400 lines of hand-written authentication, ACL, MFA, crypto and recovery logic that no external reviewer has ever read. A household archive cannot carry that obligation for a decade, and the failure mode is silent: an authentication bug in self-hosted code stays unfound until it is used.

*German business features* — DATEV, GoBD, SEPA-QR, cancellation letters — assume a trade or freelance business that does not exist here, and the ones that remain useful do not need to live inside the archive.

*AI extraction as reviewed proposals* (ADR 0004) is a careful design for a behaviour nobody has observed. It has never run against real post.

**The timing decides more than the arguments.** `storage/originals/` holds 102 files totalling 53 KB, median 82 bytes: test fixtures, every one. No real document has ever been filed. Migration cost is zero today and rises with the first genuine upload, so the eight completed release gates are sunk cost and not a reason to continue. They were also never validated against real usage, which is the other half of the same fact.

**Durability moves down a layer, where it belongs.** Gate 3 acknowledged an upload only after two independent writes verified matching hashes, and paperless-ngx has no equivalent. It also has no need for one: a ZFS mirror protects originals, archive versions, the search index and the database at once, without any application knowing about it, and scrubbing covers the bitrot case the hash comparison was written for. The application-level guarantee was solving a storage problem in the wrong place — visibly so, since `STORAGE_REPLICA_HOST_PATH` defaults to a directory beside `STORAGE_PATH` on the same filesystem, where the second write buys nothing at all. The offsite third copy survives the move as `document_exporter` output, encrypted and synced by the existing backup container; a self-describing export restores into a different paperless version, which a raw dump bound to a schema version does not.

**AI stays, and gets simpler.** paperless-ngx 3.x extracts title, correspondent, document type, tags, storage path and dates natively through `PAPERLESS_AI_LLM_BACKEND`, and `openai-like` accepts any OpenAI-compatible endpoint. Claude therefore attaches as configuration against Anthropic's compatibility layer, with no adapter and no third-party analyzer in the path — `paperless-ai` and `paperless-gpt` exist to add what this version already has, and neither supports Anthropic natively anyway. Anthropic publishes no embeddings endpoint, so retrieval embeddings run locally on the `huggingface` backend, which keeps document text for the index on the machine and costs nothing.

Two things are given up here rather than worked around. The confidence threshold and review inbox of ADR 0004 have no counterpart: paperless suggests, a person accepts, and there is no recorded proposal with a score behind it. And the roadmap's requirement of EU processing for remote AI is not met by the compatibility layer, whose request shape has no place for the native API's `inference_geo`. Sending household post to a US endpoint is a decision to take deliberately; the local Ollama backend remains the alternative that avoids it entirely.

**What survives becomes satellites.** Contract deadlines with the iCal feed, SEPA-QR, cancellation letters and DATEV export are domain logic that happened to be written against DocVault's database. They talk to the paperless REST API instead, as small separate services, and stop being reasons to own a document management system.

**This decision is revisited if** a private space becomes a real requirement between people who do not share operator access, or a business makes GoBD-compliant archiving mandatory. Neither is reachable from paperless-ngx by configuration, and both would mean choosing again rather than patching.
