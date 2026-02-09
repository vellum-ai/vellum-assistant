"use client";

import { Copy, Database, DollarSign, Eye, EyeOff, Key, Loader2, Lock, Plus, Trash2, User } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Layout } from "@/components/Layout";
import { useAuth } from "@/lib/auth";

// API Key types
interface ApiKeyScopes {
  actions: string[];
  entities: string[];
  assistant_ids: string[];
}

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScopes;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface UserProfile {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
}

// Available scopes for API keys
const AVAILABLE_ACTIONS = ["read", "write", "delete", "execute"] as const;
const AVAILABLE_ENTITIES = ["assistants", "messages", "files", "settings"] as const;

export default function SettingsPage() {
  const { isLoggedIn, isLoading, username } = useAuth();

  // Profile state
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyActions, setNewKeyActions] = useState<string[]>(["read"]);
  const [newKeyEntities, setNewKeyEntities] = useState<string[]>(["assistants"]);
  const [newKeyExpiryDays, setNewKeyExpiryDays] = useState<number | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  // Fetch profile
  const fetchProfile = useCallback(async () => {
    if (!username) return;
    setProfileLoading(true);
    try {
      const response = await fetch(`/api/profile?username=${encodeURIComponent(username)}`);
      if (response.ok) {
        const data = await response.json();
        setProfile(data);
        setDisplayName(data.display_name || "");
        setEmail(data.email || "");
      }
    } catch (error) {
      console.error("Error fetching profile:", error);
    } finally {
      setProfileLoading(false);
    }
  }, [username]);

  // Fetch API keys
  const fetchApiKeys = useCallback(async () => {
    if (!username) return;
    setApiKeysLoading(true);
    try {
      const response = await fetch(`/api/api-keys?username=${encodeURIComponent(username)}`);
      if (response.ok) {
        const data = await response.json();
        setApiKeys(data.keys || []);
      }
    } catch (error) {
      console.error("Error fetching API keys:", error);
    } finally {
      setApiKeysLoading(false);
    }
  }, [username]);

  useEffect(() => {
    if (isLoggedIn && username) {
      fetchProfile();
      fetchApiKeys();
    }
  }, [isLoggedIn, username, fetchProfile, fetchApiKeys]);

  // Save profile
  const saveProfile = async () => {
    if (!username) return;
    setProfileSaving(true);
    setProfileMessage(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          display_name: displayName || null,
          email: email || null,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setProfile(data);
        setProfileMessage({ type: "success", text: "Profile saved!" });
      } else {
        setProfileMessage({ type: "error", text: "Failed to save profile" });
      }
    } catch (error) {
      console.error("Error saving profile:", error);
      setProfileMessage({ type: "error", text: "Failed to save profile" });
    } finally {
      setProfileSaving(false);
    }
  };

  // Create API key
  const createApiKey = async () => {
    if (!username || !newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          name: newKeyName.trim(),
          scopes: {
            actions: newKeyActions,
            entities: newKeyEntities,
            assistant_ids: ["*"],
          },
          expires_in_days: newKeyExpiryDays,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setNewlyCreatedKey(data.key);
        setShowCreateKey(false);
        setNewKeyName("");
        setNewKeyActions(["read"]);
        setNewKeyEntities(["assistants"]);
        setNewKeyExpiryDays(null);
        fetchApiKeys();
      }
    } catch (error) {
      console.error("Error creating API key:", error);
    } finally {
      setCreatingKey(false);
    }
  };

  // Delete API key
  const deleteApiKey = async (keyId: string) => {
    if (!username || !confirm("Are you sure you want to delete this API key?")) return;
    try {
      const response = await fetch(`/api/api-keys?id=${keyId}&username=${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        fetchApiKeys();
      }
    } catch (error) {
      console.error("Error deleting API key:", error);
    }
  };

  // Copy to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (isLoading) {
    return null;
  }

  if (!isLoggedIn) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center px-4 py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
            <Lock className="h-8 w-8 text-zinc-400" />
          </div>
          <h2 className="mt-6 text-xl font-semibold text-zinc-900 dark:text-white">
            Sign in required
          </h2>
          <p className="mt-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Please sign in from the Home page to access settings.
          </p>
          <Link
            href="/"
            className="mt-6 flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Go to Home
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-4 sm:p-8">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-white">
            Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Configure your Vellum workspace
          </p>
        </div>

        <div className="max-w-2xl space-y-4 sm:space-y-6">
          {/* Profile Section */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950">
                <User className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h2 className="font-medium text-zinc-900 dark:text-white">
                  Profile
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Manage your account settings
                </p>
              </div>
            </div>

            {profileLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading profile...
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username || ""}
                    disabled
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800"
                  />
                  <p className="mt-1 text-xs text-zinc-400">Username cannot be changed</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Enter your display name"
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Profile Picture
                  </label>
                  <div className="mt-1 flex items-center gap-4">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                      {profile?.profile_picture_url ? (
                        <Image
                          src={profile.profile_picture_url}
                          alt="Profile"
                          width={64}
                          height={64}
                          className="h-16 w-16 rounded-full object-cover"
                        />
                      ) : (
                        <User className="h-8 w-8 text-zinc-400" />
                      )}
                    </div>
                    <p className="text-xs text-zinc-400">
                      Profile picture upload coming soon
                    </p>
                  </div>
                </div>

                {profileMessage && (
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      profileMessage.type === "success"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    }`}
                  >
                    {profileMessage.text}
                  </div>
                )}

                <button
                  onClick={saveProfile}
                  disabled={profileSaving}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                >
                  {profileSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save Profile
                </button>
              </div>
            )}
          </div>

          {/* API Keys Section */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-950">
                  <Key className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h2 className="font-medium text-zinc-900 dark:text-white">
                    API Keys
                  </h2>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    Manage your API keys for integrations
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateKey(true)}
                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
              >
                <Plus className="h-4 w-4" />
                New Key
              </button>
            </div>

            {/* Newly created key alert */}
            {newlyCreatedKey && (
              <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-900/20">
                <p className="mb-2 text-sm font-medium text-yellow-800 dark:text-yellow-200">
                  ⚠️ Save your API key now - it won&apos;t be shown again!
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-yellow-100 px-2 py-1 font-mono text-xs text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100">
                    {showKey ? newlyCreatedKey : newlyCreatedKey.replace(/(?<=.{12})./g, "•")}
                  </code>
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="rounded p-1 text-yellow-700 hover:bg-yellow-100 dark:text-yellow-300 dark:hover:bg-yellow-900/40"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => copyToClipboard(newlyCreatedKey)}
                    className="rounded p-1 text-yellow-700 hover:bg-yellow-100 dark:text-yellow-300 dark:hover:bg-yellow-900/40"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <button
                  onClick={() => setNewlyCreatedKey(null)}
                  className="mt-2 text-xs text-yellow-700 underline dark:text-yellow-300"
                >
                  I&apos;ve saved it, dismiss
                </button>
              </div>
            )}

            {/* Create key form */}
            {showCreateKey && (
              <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
                <h3 className="mb-3 text-sm font-medium text-zinc-900 dark:text-white">
                  Create new API key
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Name
                    </label>
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="e.g., Production API"
                      className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-zinc-600 dark:bg-zinc-700 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Actions
                    </label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {AVAILABLE_ACTIONS.map((action) => (
                        <label key={action} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={newKeyActions.includes(action)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setNewKeyActions([...newKeyActions, action]);
                              } else {
                                setNewKeyActions(newKeyActions.filter((a) => a !== action));
                              }
                            }}
                            className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <span className="text-xs text-zinc-600 dark:text-zinc-400">{action}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Entities
                    </label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {AVAILABLE_ENTITIES.map((entity) => (
                        <label key={entity} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={newKeyEntities.includes(entity)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setNewKeyEntities([...newKeyEntities, entity]);
                              } else {
                                setNewKeyEntities(newKeyEntities.filter((ent) => ent !== entity));
                              }
                            }}
                            className="rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <span className="text-xs text-zinc-600 dark:text-zinc-400">{entity}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Expiration
                    </label>
                    <select
                      value={newKeyExpiryDays ?? ""}
                      onChange={(e) => setNewKeyExpiryDays(e.target.value ? Number(e.target.value) : null)}
                      className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-zinc-600 dark:bg-zinc-700 dark:text-white"
                    >
                      <option value="">Never expires</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">1 year</option>
                    </select>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={createApiKey}
                      disabled={creatingKey || !newKeyName.trim() || newKeyActions.length === 0 || newKeyEntities.length === 0}
                      className="flex items-center gap-2 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {creatingKey && <Loader2 className="h-3 w-3 animate-spin" />}
                      Create Key
                    </button>
                    <button
                      onClick={() => setShowCreateKey(false)}
                      className="rounded px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* API keys list */}
            <div className="mt-4">
              {apiKeysLoading ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading API keys...
                </div>
              ) : apiKeys.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  No API keys yet. Create one to get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((key) => (
                    <div
                      key={key.id}
                      className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-900 dark:text-white">
                            {key.name}
                          </span>
                          <code className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                            {key.key_prefix}...
                          </code>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {key.scopes.actions.map((action) => (
                            <span
                              key={action}
                              className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            >
                              {action}
                            </span>
                          ))}
                          {key.scopes.entities.map((entity) => (
                            <span
                              key={entity}
                              className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                            >
                              {entity}
                            </span>
                          ))}
                        </div>
                        <p className="mt-1 text-xs text-zinc-400">
                          Created {new Date(key.created_at).toLocaleDateString()}
                          {key.expires_at && ` · Expires ${new Date(key.expires_at).toLocaleDateString()}`}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteApiKey(key.id)}
                        className="ml-2 rounded p-1.5 text-zinc-400 transition-colors hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Database Section */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950">
                <Database className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h2 className="font-medium text-zinc-900 dark:text-white">
                  Database
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Configure your database connection
                </p>
              </div>
            </div>
            <div className="mt-4">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Database connection is configured via the{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
                  DATABASE_URL
                </code>{" "}
                environment variable in Vercel.
              </p>
            </div>
          </div>

          {/* Cost Tracking Section */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950">
                <DollarSign className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <h2 className="font-medium text-zinc-900 dark:text-white">
                  Cost Tracking
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Monitor usage costs across categories
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
                <div>
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-white">
                    Compute
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Infrastructure and processing costs
                  </p>
                </div>
                <span className="text-sm font-medium text-zinc-900 dark:text-white">
                  $0.00
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
                <div>
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-white">
                    Tokens
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    LLM token usage costs
                  </p>
                </div>
                <span className="text-sm font-medium text-zinc-900 dark:text-white">
                  $0.00
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50">
                <div>
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-white">
                    Medical
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Medical costs from Vellum Doctor
                  </p>
                </div>
                <span className="text-sm font-medium text-zinc-900 dark:text-white">
                  $0.00
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
