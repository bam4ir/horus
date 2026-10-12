import React from 'react';
import {Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {ScreenShell} from '../screen/ScreenShell';
import {BackgroundPermissionsPanel} from './BackgroundPermissions';
import {BrandBackButton, BrandHeader, uiColors} from './brand';
import {DownloadSourcesPanel} from './DownloadSourcesPanel';
import {InteractivePressable as Pressable} from './InteractivePressable';
import {RemoteAccessPanel} from './RemoteAccessPanel';
import {SettingsAction, SettingsExternalMark, SettingsRow, SettingsSection} from './SettingsList';
import {UI_FONT_FAMILY} from './typography';
import {useHardwareBack} from './useHardwareBack';
import {DISTRO_NAMES, LINUX_DISTROS, type ProfileUser} from '../profile/profileStore';
import {ProfileAvatar} from './ProfileAvatar';
import {
  readSessionSettings,
  TERMINAL_SESSION_LIMIT_MAX,
  TERMINAL_SESSION_LIMIT_MIN,
  writeSessionLimit,
  type SessionSettings,
  type SessionSettingsResult,
} from '../terminal/session/sessionSettings';

export const HORUS_DOCS_URL = 'https://www.scariflabs.com/horus/docs';

type SessionSettingsScreenProps = Readonly<{
  onBack: () => void;
  /** Every user, at most one per distribution. */
  users?: readonly ProfileUser[];
  /** Opens the flow that adds the user for the distribution without one. */
  onAddUser?: () => void;
  openUrl?: (url: string) => Promise<unknown>;
  readSettings?: () => Promise<SessionSettingsResult>;
  saveLimit?: (limit: number) => Promise<SessionSettingsResult>;
}>;

function errorLabel(errorCode: string): string {
  if (errorCode === 'unavailable') return 'The native runtime is unavailable. Reopen Horus and try again.';
  if (errorCode === 'invalid_response') return 'Horus returned an unreadable settings response. Try again.';
  return 'Could not save this setting. Try again.';
}

function limitLabel(limit: number): string {
  return limit === 1 ? '1 app' : `${limit} apps`;
}

export function SessionSettingsScreen({onBack, users = [], onAddUser, openUrl = url => Linking.openURL(url), readSettings = readSessionSettings, saveLimit = writeSessionLimit}: SessionSettingsScreenProps): React.JSX.Element {
  const [settings, setSettings] = React.useState<SessionSettings | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const mountedRef = React.useRef(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await readSettings();
    if (!mountedRef.current) return;
    if (result.kind === 'success') {
      setSettings(result.settings);
    } else {
      setError(errorLabel(result.errorCode));
    }
    setLoading(false);
  }, [readSettings]);

  React.useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useHardwareBack(true, onBack);

  const chooseLimit = React.useCallback(async (limit: number) => {
    if (settings === undefined || saving || limit === settings.maxConcurrentSessions) return;
    setSaving(true);
    setError(undefined);
    const result = await saveLimit(limit);
    if (!mountedRef.current) return;
    if (result.kind === 'success') {
      setSettings(result.settings);
    } else {
      setError(errorLabel(result.errorCode));
    }
    setSaving(false);
  }, [saveLimit, saving, settings]);

  return (
    <ScreenShell testID="session-settings-screen">
      <ScrollView contentContainerStyle={styles.content}>
        <BrandHeader
          eyebrow="HORUS"
          title="Settings"
          meta={null}
          action={(
            <BrandBackButton onPress={onBack} testID="settings-back" />
          )}
        />

        <SettingsSection
          footer={error === undefined ? (
            <Text style={styles.footer} testID="settings-session-limit-current">
              {loading ? 'Loading…' : settings === undefined ? 'Unavailable' : `Up to ${limitLabel(settings.maxConcurrentSessions)} at once. Each keeps its own notification while Horus is in the background.`}
            </Text>
          ) : (
            <View style={styles.errorRow}>
              <Text style={styles.error} testID="settings-error">{error}</Text>
              {loading ? null : <SettingsAction label="RETRY" onPress={() => { void refresh(); }} testID="settings-retry" tone="danger" />}
            </View>
          )}
          title="SESSIONS">
          <SettingsRow
            icon="layers"
            label="Apps at once"
            right={(
              <View style={styles.options}>
                {Array.from({length: TERMINAL_SESSION_LIMIT_MAX - TERMINAL_SESSION_LIMIT_MIN + 1}, (_, index) => index + TERMINAL_SESSION_LIMIT_MIN).map(limit => {
                  const selected = settings?.maxConcurrentSessions === limit;
                  return (
                    <Pressable
                      key={limit}
                      accessibilityLabel={limitLabel(limit)}
                      accessibilityRole="button"
                      accessibilityState={{disabled: loading || saving, selected}}
                      disabled={loading || saving}
                      onPress={() => { void chooseLimit(limit); }}
                      style={[styles.option, selected && styles.optionSelected, (loading || saving) && styles.optionDisabled]}
                      testID={`settings-session-limit-${limit}`}>
                      <Text style={[styles.optionValue, selected && styles.optionValueSelected]}>{limit}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          />
        </SettingsSection>

        <UsersSection onAddUser={onAddUser} users={users} />

        <BackgroundPermissionsPanel />
        <RemoteAccessPanel />
        <DownloadSourcesPanel />

        <SettingsSection title="HELP">
          <SettingsRow
            accessibilityLabel="Open the Horus documentation in your browser"
            detail="scariflabs.com/horus/docs"
            icon="book"
            label="Documentation"
            onPress={() => { openUrl(HORUS_DOCS_URL).catch(() => undefined); }}
            right={<SettingsExternalMark />}
            testID="settings-docs"
          />
        </SettingsSection>
      </ScrollView>
    </ScreenShell>
  );
}

/** One user per distribution; the missing one can be added here. */
function UsersSection({users, onAddUser}: Readonly<{users: readonly ProfileUser[]; onAddUser?: () => void}>): React.JSX.Element | null {
  if (users.length === 0) return null;
  const missing = LINUX_DISTROS.find(distro => !users.some(user => user.distro === distro));
  return (
    <SettingsSection
      footer={users.length > 1 ? 'Each user has their own Linux and home. Lock Horus and sign in as the other user to switch; running sessions keep going.' : undefined}
      testID="settings-users"
      title="USERS">
      {users.map(user => (
        <SettingsRow
          key={user.distro}
          detail={`${DISTRO_NAMES[user.distro]} · /home/${user.username}`}
          label={user.username}
          right={<ProfileAvatar avatar={user.avatar} size={36} />}
          testID={`settings-user-${user.distro}`}
        />
      ))}
      {missing === undefined || onAddUser === undefined ? null : (
        <SettingsRow
          detail={missing === 'debian' ? 'glibc and apt, for tools Alpine can’t run. Experimental.' : 'Small and fast, with musl and apk.'}
          label={`Add a ${DISTRO_NAMES[missing]} user`}
          right={<SettingsAction label="ADD" onPress={onAddUser} testID="settings-add-user" />}
          testID={`settings-add-${missing}`}
        />
      )}
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  content: {paddingHorizontal: 18, paddingBottom: 28},
  options: {backgroundColor: uiColors.background, borderColor: uiColors.borderSoft, borderRadius: 8, borderWidth: 1, flexDirection: 'row', gap: 2, marginLeft: 10, padding: 2},
  option: {alignItems: 'center', borderRadius: 6, height: 30, justifyContent: 'center', width: 32},
  optionSelected: {backgroundColor: uiColors.accent},
  optionDisabled: {opacity: 0.55},
  optionValue: {color: uiColors.muted, fontFamily: UI_FONT_FAMILY, fontSize: 12, fontWeight: '800'},
  optionValueSelected: {color: uiColors.background},
  footer: {color: uiColors.subdued, fontFamily: UI_FONT_FAMILY, fontSize: 9, lineHeight: 14, marginHorizontal: 4, marginTop: 8},
  errorRow: {alignItems: 'center', flexDirection: 'row', marginHorizontal: 4, marginTop: 8},
  error: {color: uiColors.danger, flex: 1, fontFamily: UI_FONT_FAMILY, fontSize: 9, lineHeight: 14},
});
