# Just-in-Time Onboarding Recipes

## Status: Not Yet Wired

The recipe execution engine (`RecipeExecutor`) has been removed as part of the migration
to proxy-based computer use. The recipe markdown files remain for future reference
— a new executor will be built on top of the `host_cu_request` / `host_cu_result`
proxy flow when the integration picker is built.

### Available Recipe Files

```
recipes/
├── README.md                    # this file
└── github-app-setup.md          # Register + install GitHub App
```

---

## Security Considerations

- Recipe execution requires explicit user consent ("I'll use your mouse and keyboard")
- `ActionVerifier` safety checks remain active during recipe execution
  (no destructive keys, no sensitive data exposure, loop detection)
- Credentials are never sent to the LLM after capture — they are
  extracted in a post-processing step (secure storage TBD)
