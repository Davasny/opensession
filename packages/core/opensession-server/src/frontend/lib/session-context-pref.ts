// Whether the transcript opens with the "Session context" row: everything the
// model received before the first message. A debugging aid, so it is off by
// default (Settings → Preferences → Debug) and follows the user across
// devices like the other makeUserPref instances.

import * as UserPref from "./user-pref";

const pref = UserPref.makeUserPref<boolean>({
  localKey: "opensession-session-context-row",
  prefKey: "session-context-row",
  changeEvent: "opensession-session-context-row-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getSessionContextRowPref = pref.get;
export const setSessionContextRowPref = pref.set;
export const onSessionContextRowChanged = pref.onChanged;
