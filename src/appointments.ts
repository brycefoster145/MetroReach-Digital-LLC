/**
 * Appointment Booking System
 * 
 * Used by the voice handler to book, reschedule, and cancel appointments.
 * Includes availability checking and double-booking prevention.
 */

import { randomUUID } from "node:crypto";
import { getTenantBySlug, createAppointment, updateAppointment, getAppointments, checkAvailability } from "./db.js";
import { syncAppointmentToCalendar, cancelCalendarEvent } from "./calendar.js";

export interface BookResult {
  success: boolean;
  appointmentId?: string;
  message: string;
}

export async function bookAppointment(
  slug: string,
  details: {
    callerName: string;
    callerPhone: string;
    callerEmail?: string;
    staffName?: string;
    dateTime: string; // ISO-ish: "Monday at 3pm", "2026-07-25T15:00"
    duration?: number; // minutes, default 60
  },
): Promise<BookResult> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return { success: false, message: "Business not found." };
  }

  // Parse the datetime
  const start = parseDateTime(details.dateTime);
  if (!start) {
    return { success: false, message: "I couldn't understand that date and time. Could you try again, like 'Monday at 3 PM'?" };
  }

  const duration = details.duration || 60;
  const end = new Date(start.getTime() + duration * 60000).toISOString();

  // Check availability
  const available = await checkAvailability(tenant.id, start.toISOString(), end);
  if (!available) {
    return { success: false, message: "That time slot is already booked. Would you like to try a different time?" };
  }

  try {
    const appt = await createAppointment({
      id: randomUUID(),
      tenant_id: tenant.id,
      caller_name: details.callerName,
      caller_phone: details.callerPhone,
      caller_email: details.callerEmail,
      staff_name: details.staffName,
      start_time: start.toISOString(),
      end_time: end,
    });

    // Try calendar sync in background
    syncAppointmentToCalendar(appt.id, tenant.id).catch(() => {});

    const timeStr = start.toLocaleString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });

    return {
      success: true,
      appointmentId: appt.id,
      message: `You're all set! I've booked your appointment for ${timeStr}. Is there anything else I can help with?`,
    };
  } catch (error: any) {
    return { success: false, message: error.message || "Sorry, I couldn't book that appointment." };
  }
}

export async function rescheduleAppointment(
  slug: string,
  appointmentId: string,
  newDateTime: string,
): Promise<BookResult> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return { success: false, message: "Business not found." };
  }

  const newStart = parseDateTime(newDateTime);
  if (!newStart) {
    return { success: false, message: "I couldn't understand that date and time." };
  }

  const newEnd = new Date(newStart.getTime() + 60 * 60000).toISOString();

  try {
    await updateAppointment(appointmentId, {
      start_time: newStart.toISOString(),
      end_time: newEnd,
    });

    // Re-sync calendar
    syncAppointmentToCalendar(appointmentId, tenant.id).catch(() => {});

    return { success: true, message: "Your appointment has been rescheduled. Is there anything else?" };
  } catch (error: any) {
    return { success: false, message: error.message || "I couldn't reschedule that appointment." };
  }
}

export async function cancelAppointment(
  slug: string,
  appointmentId: string,
): Promise<BookResult> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return { success: false, message: "Business not found." };
  }

  try {
    await updateAppointment(appointmentId, { status: "cancelled" });
    cancelCalendarEvent(appointmentId, tenant.id).catch(() => {});
    return { success: true, message: "Your appointment has been cancelled. Is there anything else I can help with?" };
  } catch (error: any) {
    return { success: false, message: "I couldn't cancel that appointment." };
  }
}

export async function getUpcomingAppointments(slug: string): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return "No appointments found.";

  const now = new Date().toISOString();
  const appts = await getAppointments(tenant.id, now);

  if (!appts || appts.length === 0) {
    return "You have no upcoming appointments.";
  }

  const upcoming = (appts as any[]).filter(a => a.status !== "cancelled").slice(0, 5);
  if (upcoming.length === 0) return "You have no upcoming appointments.";

  const list = upcoming.map((a: any) => {
    const d = new Date(a.start_time);
    return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  });

  return `You have ${upcoming.length} upcoming appointment${upcoming.length > 1 ? "s" : ""}: ${list.join("; ")}.`;
}

// ── Datetime parser ──────────────────────────────────────
function parseDateTime(input: string): Date | null {
  // Already ISO
  const isoMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (isoMatch) {
    return new Date(isoMatch[0]);
  }

  // "Monday at 3pm" / "tomorrow at 2:30"
  const now = new Date();
  let target = new Date(now);

  const text = input.toLowerCase().trim();

  // Day resolution
  const days: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  if (text.includes("tomorrow")) {
    target.setDate(target.getDate() + 1);
  } else if (text.includes("today")) {
    // keep today
  } else {
    for (const [day, num] of Object.entries(days)) {
      if (text.includes(day)) {
        const currentDay = target.getDay();
        let diff = num - currentDay;
        if (diff <= 0) diff += 7; // next week
        target.setDate(target.getDate() + diff);
        break;
      }
    }
  }

  // Time resolution
  const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const min = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3].toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    target.setHours(hour, min, 0, 0);
  } else {
    target.setHours(9, 0, 0, 0); // default to 9am
  }

  if (target <= now) {
    target.setDate(target.getDate() + 7); // push to next week
  }

  return target;
}
