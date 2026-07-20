/**
 * Phase 2 — CRM Integrations (HubSpot, Salesforce)
 *
 * Push/pull customer records, log calls, update profiles.
 * Uses REST APIs with API-key auth.
 */

import { getTenantById } from "./db.js";

interface CrmConfig {
  provider?: "hubspot" | "salesforce" | "none";
  hubspot?: { apiKey: string };
  salesforce?: { instanceUrl: string; accessToken: string };
}

function parseCrmConfig(tenant: any): CrmConfig | null {
  try {
    const routing = JSON.parse(tenant.routing_rules || "{}");
    return routing.crm || null;
  } catch { return null; }
}

// ── HubSpot integration ───────────────────────────────────
async function hubspotRequest(
  apiKey: string,
  endpoint: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown,
): Promise<any> {
  const url = `https://api.hubapi.com/crm/v3${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ── Salesforce integration ────────────────────────────────
async function salesforceRequest(
  instanceUrl: string,
  accessToken: string,
  query: string,
): Promise<any> {
  const url = `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  return res.json();
}

// ── Public API ────────────────────────────────────────────

export interface CrmContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CrmCallLog {
  contactId: string;
  duration: number;
  outcome: string;
  notes: string;
  timestamp: string;
}

// ── Search for contact ────────────────────────────────────
export async function findContact(tenantId: string, phoneOrEmail: string): Promise<CrmContact | null> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return null;

  const config = parseCrmConfig(tenant);
  if (!config || config.provider === "none") return null;

  try {
    if (config.provider === "hubspot" && config.hubspot?.apiKey) {
      const isEmail = phoneOrEmail.includes("@");
      const filter = isEmail
        ? `email=${encodeURIComponent(phoneOrEmail)}`
        : `phone=${encodeURIComponent(phoneOrEmail)}`;
      const data = await hubspotRequest(config.hubspot.apiKey, `/objects/contacts/search`, "POST", {
        filterGroups: [{
          filters: [{ propertyName: isEmail ? "email" : "phone", operator: "EQ", value: phoneOrEmail }],
        }],
      });
      if (data.results?.length > 0) {
        const c = data.results[0];
        return {
          id: c.id,
          firstName: c.properties?.firstname || "",
          lastName: c.properties?.lastname || "",
          email: c.properties?.email || "",
          phone: c.properties?.phone || "",
        };
      }
    }

    if (config.provider === "salesforce" && config.salesforce) {
      const isEmail = phoneOrEmail.includes("@");
      const field = isEmail ? "Email" : "Phone";
      const data = await salesforceRequest(
        config.salesforce.instanceUrl,
        config.salesforce.accessToken,
        `SELECT Id, FirstName, LastName, Email, Phone FROM Contact WHERE ${field} = '${phoneOrEmail}' LIMIT 1`,
      );
      if (data.records?.length > 0) {
        const c = data.records[0];
        return {
          id: c.Id,
          firstName: c.FirstName || "",
          lastName: c.LastName || "",
          email: c.Email || "",
          phone: c.Phone || "",
        };
      }
    }
  } catch (err) {
    console.error(`[crm] findContact error:`, err);
  }

  return null;
}

// ── Log call to CRM ───────────────────────────────────────
export async function logCallToCrm(tenantId: string, log: CrmCallLog): Promise<boolean> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return false;

  const config = parseCrmConfig(tenant);
  if (!config) return false;

  try {
    if (config.provider === "hubspot" && config.hubspot?.apiKey) {
      await hubspotRequest(config.hubspot.apiKey, "/objects/calls", "POST", {
        properties: {
          hs_call_duration: String(log.duration),
          hs_call_outcome: log.outcome,
          hs_call_body: log.notes,
          hs_timestamp: log.timestamp,
        },
        associations: [{
          to: { id: log.contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 194 }],
        }],
      });
      return true;
    }

    if (config.provider === "salesforce" && config.salesforce) {
      // Salesforce Task creation for call log
      await fetch(`${config.salesforce.instanceUrl}/services/data/v58.0/sobjects/Task`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.salesforce.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          WhoId: log.contactId,
          Subject: `Call - ${log.outcome} (${log.duration}s)`,
          Description: log.notes,
          CallDurationInSeconds: log.duration,
          Status: "Completed",
        }),
      });
      return true;
    }
  } catch (err) {
    console.error(`[crm] logCallToCrm error:`, err);
  }

  return false;
}
