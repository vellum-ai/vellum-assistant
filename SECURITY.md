# Security Considerations

This document outlines security considerations and recommendations for the Vellum Assistant platform.

## Authentication & Authorization

### Current State

The platform has an API key system defined in `web/src/app/api/api-keys/route.ts`, but many API endpoints currently lack authentication middleware.

### Critical Endpoints Requiring Authentication

The following endpoints should be protected with proper authentication:

#### Administrative Endpoints
- `POST /api/prequeue` - Instance management (create, cleanup)
- `GET /api/prequeue` - View prequeue pool status

#### Agent Management
- `POST /api/agents` - Create new agents
- `DELETE /api/agents/[id]` - Delete agents
- `PATCH /api/agents/[id]` - Update agent configuration
- `POST /api/agents/[id]/start` - Start agent instances
- `POST /api/agents/[id]/stop` - Stop agent instances
- `POST /api/agents/[id]/kill` - Force stop agents
- `POST /api/agents/[id]/setup-email` - Configure agent email

#### Message Endpoints
- `POST /api/agents/[id]/messages` - Send messages to agents
- `GET /api/agents/[id]/messages` - View agent message history

### Recommendations

1. **Implement Authentication Middleware**
   - Create a middleware to validate API keys or session tokens
   - Apply middleware to all sensitive endpoints
   - Use Next.js middleware (`middleware.ts`) for route protection

2. **Authorization Scopes**
   - Leverage the existing `ApiKeyScopes` system
   - Implement fine-grained permissions (read/write/delete/execute)
   - Entity-level scoping (agents, messages, files, settings)
   - Agent-level scoping (per-agent access control)

3. **Rate Limiting**
   - Implement rate limiting on all API endpoints
   - Use per-user/per-key rate limits
   - Consider using a service like Upstash Redis for distributed rate limiting

4. **Input Validation**
   - Add request validation for all API endpoints
   - Consider using Zod or similar library for schema validation
   - Sanitize all user inputs

## Data Security

### Database

- ✅ Uses connection string from environment variables
- ✅ API keys are hashed (SHA-256) before storage
- ⚠️ Consider adding encryption at rest for sensitive configuration data
- ⚠️ Implement database connection pooling limits

### Secrets Management

- ✅ Environment variables for sensitive data
- ✅ `.env` files excluded from version control
- ⚠️ Consider using a secrets management service (Google Secret Manager, AWS Secrets Manager)
- ⚠️ Rotate API keys and service account credentials regularly

### Google Cloud

- ✅ Migrated to Workload Identity Federation (no long-lived service account keys)
- ✅ Uses OIDC tokens for GitHub Actions
- ⚠️ Review IAM permissions for least-privilege access
- ⚠️ Enable audit logging for all GCP resources

## Infrastructure Security

### Compute Instances

- ⚠️ Agent instances should use private IPs where possible
- ⚠️ Implement firewall rules to restrict access
- ⚠️ Regular security patching of base images
- ⚠️ Consider using VPC Service Controls

### Network Security

- ⚠️ Implement HTTPS only (current local dev uses HTTP)
- ⚠️ Use secure headers (HSTS, CSP, X-Frame-Options)
- ⚠️ Configure CORS policies appropriately

## Logging & Monitoring

### Recommendations

1. **Audit Logging**
   - Log all authentication attempts
   - Log all administrative actions
   - Log agent lifecycle events (create, start, stop, delete)
   - Store logs securely with retention policies

2. **Monitoring**
   - Monitor failed authentication attempts
   - Alert on unusual API usage patterns
   - Track resource usage per user/agent
   - Set up alerts for security events

3. **Error Handling**
   - Don't leak sensitive information in error messages
   - Use generic errors for auth failures
   - Log detailed errors server-side only

## Dependency Security

### Current Tools

- Using npm for dependency management
- Next.js, React, and other modern frameworks

### Recommendations

1. **Dependency Scanning**
   - Enable Dependabot alerts
   - Run `npm audit` regularly
   - Consider using Snyk or similar tools
   - Keep dependencies up to date

2. **Supply Chain Security**
   - Use `package-lock.json` to pin dependency versions
   - Review dependencies before adding them
   - Use `npm ci` in production/CI (already implemented)

## Compliance & Privacy

### Data Handling

- ⚠️ Document what user data is collected and stored
- ⚠️ Implement data retention policies
- ⚠️ Provide data export/deletion capabilities
- ⚠️ Consider GDPR/CCPA compliance requirements

### Third-Party Services

- Anthropic Claude API (AI capabilities)
- Google Cloud Platform (compute/storage)
- Document all data sharing with third parties

## Incident Response

### Recommendations

1. **Prepare an Incident Response Plan**
   - Define roles and responsibilities
   - Document escalation procedures
   - Maintain contact list for security team

2. **Security Contact**
   - Define a security@vellum.ai contact email
   - Document vulnerability disclosure process
   - Set up security.txt file

## Next Steps

1. **Immediate Priority**
   - [ ] Implement authentication middleware for API routes
   - [ ] Add input validation to all endpoints
   - [ ] Enable rate limiting

2. **Short Term**
   - [ ] Security audit of all API endpoints
   - [ ] Implement proper authorization scopes
   - [ ] Add audit logging

3. **Long Term**
   - [ ] Penetration testing
   - [ ] Security training for developers
   - [ ] Regular security reviews

## Reporting Security Issues

If you discover a security vulnerability, please email security@vellum.ai (or the appropriate contact) rather than opening a public issue.

---

Last updated: 2026-02-08
