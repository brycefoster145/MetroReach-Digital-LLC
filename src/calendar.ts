/**
 * Calendar Integration — Google Calendar + Outlook
 * 
 * Syncs appointments to external calendars.
 * Each tenant can configure their calendar provider in tenant.calendar_config.
 */

import { getTenantById, updateAppointment } from "./db-v2.js";

interface CalendarConfig {
  provider?: "google" | "outlook" | "none";
  google?: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    calendarId?: string;
  };
  outlook?: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    userId?: string;
  };
}

interface CalendarEvent {
  summary: string;
  description?: string;
  start: string; // ISO datetime
  end: string;   // ISO datetime
  attendees?: { name?: string; phone?: string; email?: string }[];
}

export async function syncAppointmentToCalendar(
  appointmentId: string,
  tenantId: string,
): Promise<{ provider: string; eventId: string } | null> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return null;

  let config: CalendarConfig;
  try {
    config = JSON.parse(tenant.calendar_config || "{}");
  } catch {
    return null;
  }

  if (!config.provider || config.provider === "none") return null;

  const appointment = await (await import("./db-v2.js")).getAppointments(tenantId, undefined, undefined)
    .then(rows => (rows as any[]).find(a => a.id === appointmentId));
  if (!appointment) return null;

  const event: CalendarEvent = {
    summary: `Appointment: ${appointment.caller_name || "Caller"} at ${tenant.name}`,
    description: `Phone: ${appointment.caller_phone || "N/A"}\nNotes: ${appointment.notes || "N/A"}`,
    start: appointment.start_time,
    end: appointment.end_time,
    attendees: [{
      name: appointment.caller_name,
      phone: appointment.caller_phone,
      email: appointment.caller_email,
    }],
  };

  try {
    if (config.provider === "google" && config.google) {
      return await syncToGoogle(config.google, event, appointmentId);
    }
    if (config.provider === "outlook" && config.outlook) {
      return await syncToOutlook(config.outlook, event, appointmentId);
    }
  } catch (error: any) {
    console.error("Calendar sync error:", error.message);
  }

  return null;
}

async function syncToGoogle(
  config: NonNullable<CalendarConfig["google"]>,
  event: CalendarEvent,
  appointmentId: string,
): Promise<{ provider: string; eventId: string } | null> {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    console.log("Google Calendar not fully configured for this tenant");
    return null;
  }

  const calendarId = config.calendarId || "primary";

  // Exchange refresh token for access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    console.error("Google token refresh failed:", await tokenRes.text());
    return null;
  }

  const { access_token } = await tokenRes.json() as { access_token: string };

  // Create calendar event
  const eventRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.start, timeZone: "America/Chicago" },
        end: { dateTime: event.end, timeZone: "America/Chicago" },
        attendees: event.attendees?.map(a => ({ displayName: a.name, email: a.email })).filter(a => a.email),
      }),
    },
  );

  if (!eventRes.ok) {
    console.error("Google event creation failed:", await eventRes.text());
    return null;
  }

  const { id: googleEventId } = await eventRes.json() as { id: string };

  // Update local appointment with calendar event ID
  await updateAppointment(appointmentId, {
    calendar_event_id: googleEventId,
    calendar_provider: "google",
  });

  return { provider: "google", eventId: googleEventId };
}

async function syncToOutlook(
  config: NonNullable<CalendarConfig["outlook"]>,
  event: CalendarEvent,
  appointmentId: string,
): Promise<{ provider: string; eventId: string } | null> {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    console.log("Outlook Calendar not fully configured for this tenant");
    return null;
  }

  // Exchange refresh token for access token
  const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/Calendars.ReadWrite",
    }),
  });

  if (!tokenRes.ok) {
    console.error("Outlook token refresh failed:", await tokenRes.text());
    return null;
  }

  const { access_token } = await tokenRes.json() as { access_token: string };

  const userId = config.userId || "me";

  // Create calendar event via Microsoft Graph
  const eventRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/calendar/events`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: event.summary,
        body: { contentType: "text", content: event.description },
        start: { dateTime: event.start, timeZone: "Central Standard Time" },
        end: { dateTime: event.end, timeZone: "Central Standard Time" },
        attendees: event.attendees?.map(a => ({
          emailAddress: { address: a.email, name: a.name },
          type: "required",
        })).filter(a => a.emailAddress.address),
      }),
    },
  );

  if (!eventRes.ok) {
    console.error("Outlook event creation failed:", await eventRes.text());
    return null;
  }

  const { id: outlookEventId } = await eventRes.json() as { id: string };

  await updateAppointment(appointmentId, {
    calendar_event_id: outlookEventId,
    calendar_provider: "outlook",
  });

  return { provider: "outlook", eventId: outlookEventId };
}

export async function cancelCalendarEvent(appointmentId: string, tenantId: string): Promise<boolean> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return false;

  const config: CalendarConfig = JSON.parse(tenant.calendar_config || "{}");
  const appointment = await (await import("./db-v2.js")).getAppointments(tenantId)
    .then(rows => (rows as any[]).find(a => a.id === appointmentId));
  if (!appointment?.calendar_event_id) return false;

  try {
    if (appointment.calendar_provider === "google" && config.google) {
      // Get access token and delete event
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.google.clientId!,
          client_secret: config.google.clientSecret!,
          refresh_token: config.google.refreshToken!,
          grant_type: "refresh_token",
        }),
      });
      const { access_token } = await tokenRes.json() as { access_token: string };
      const calendarId = config.google.calendarId || "primary";
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${appointment.calendar_event_id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${access_token}` } },
      );
      return true;
    }
  } catch (error: any) {
    console.error("Calendar cancel error:", error.message);
  }

  return false;
}
