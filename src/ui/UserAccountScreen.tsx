import React from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {DISTRO_NAMES, LINUX_DISTROS, usernameProblem, type AvatarId, type ProfileUser, type SaveProfileResult} from '../profile/profileStore';
import {AvatarPicker} from './AccountForm';
import {InteractivePressable as Pressable} from './InteractivePressable';
import {ScreenShell} from '../screen/ScreenShell';
import {BrandBackButton, BrandHeader, uiColors} from './brand';
import {ProfileAvatar} from './ProfileAvatar';
import {SettingsAction, SettingsRow, SettingsSection} from './SettingsList';
import {UI_FONT_FAMILY} from './typography';
import {useHardwareBack} from './useHardwareBack';

export type UserAccountScreenProps = Readonly<{
  /** The signed-in user. */
  user: ProfileUser;
  /** Every user, at most one per distribution. */
  users: readonly ProfileUser[];
  onBack: () => void;
  /** Opens the flow that adds the user for the distribution without one. */
  onAddUser?: () => void;
  /** Locks Horus for the sign-in screen; running sessions keep going. */
  onSwitchUser?: () => void;
  /** Stops every running session and returns to sign in; false if the stop failed. */
  onLogout?: () => Promise<boolean>;
  /** Saves a new username or avatar for the signed-in user. */
  onUpdateUser?: (user: ProfileUser) => Promise<SaveProfileResult>;
}>;

/** Everything about Linux users, opened from the user card on the home screen. */
export function UserAccountScreen({user, users, onBack, onAddUser, onSwitchUser, onLogout, onUpdateUser}: UserAccountScreenProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  // Back leaves the editor first, then the screen.
  useHardwareBack(true, editing ? () => setEditing(false) : onBack);
  const missing = LINUX_DISTROS.find(distro => !users.some(other => other.distro === distro));
  const others = users.filter(other => other.distro !== user.distro);

  return (
    <ScreenShell testID="user-account-screen">
      <ScrollView contentContainerStyle={styles.content}>
        <BrandHeader
          eyebrow="LINUX USER"
          title="Account"
          meta={null}
          action={<BrandBackButton onPress={onBack} testID="user-account-back" />}
        />

        {editing && onUpdateUser !== undefined ? (
          <EditUserCard onCancel={() => setEditing(false)} onSave={onUpdateUser} onSaved={() => setEditing(false)} user={user} />
        ) : (
          <View style={styles.card} testID="user-account-card">
            <ProfileAvatar avatar={user.avatar} selected size={72} />
            <Text numberOfLines={1} style={styles.username} testID="user-account-name">{user.username}</Text>
            <Text style={styles.distro}>{DISTRO_NAMES[user.distro].toUpperCase()}</Text>
            <Text style={styles.home} testID="user-account-home">/home/{user.username}</Text>
            {onUpdateUser === undefined ? null : (
              <View style={styles.editAction}>
                <SettingsAction label="EDIT" onPress={() => setEditing(true)} testID="user-account-edit" />
              </View>
            )}
          </View>
        )}

        <SettingsSection
          footer={others.length > 0 ? 'Each user has their own Linux and home. Switching keeps running sessions going.' : undefined}
          testID="user-account-users"
          title="USERS">
          {others.map(other => (
            <SettingsRow
              key={other.distro}
              detail={`${DISTRO_NAMES[other.distro]} · /home/${other.username}`}
              label={other.username}
              right={<ProfileAvatar avatar={other.avatar} size={36} />}
              testID={`user-account-user-${other.distro}`}
            />
          ))}
          {others.length === 0 || onSwitchUser === undefined ? null : (
            <SettingsRow
              detail="Locks Horus and opens sign in."
              label="Switch user"
              right={<SettingsAction label="SWITCH" onPress={onSwitchUser} testID="user-account-switch" />}
              testID="user-account-switch-row"
            />
          )}
          {missing === undefined || onAddUser === undefined ? null : (
            <SettingsRow
              detail={missing === 'debian' ? 'glibc and apt, for tools Alpine can’t run. Experimental.' : 'Small and fast, with musl and apk.'}
              label={`Add ${missing === 'alpine' ? 'an' : 'a'} ${DISTRO_NAMES[missing]} user`}
              right={<SettingsAction label="ADD" onPress={onAddUser} testID="user-account-add-user" />}
              testID={`user-account-add-${missing}`}
            />
          )}
        </SettingsSection>

        {onLogout === undefined ? null : <LogoutSection onLogout={onLogout} />}
      </ScrollView>
    </ScreenShell>
  );
}

/** The signed-in user's hieroglyph and Linux username. The password stays as it is. */
function EditUserCard({user, onSave, onSaved, onCancel}: Readonly<{
  user: ProfileUser;
  onSave: (user: ProfileUser) => Promise<SaveProfileResult>;
  onSaved: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const [avatar, setAvatar] = React.useState<AvatarId>(user.avatar);
  const [username, setUsername] = React.useState(user.username);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const changed = avatar !== user.avatar || username !== user.username;

  const save = React.useCallback(async () => {
    const problem = usernameProblem(username);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    const result = await onSave({distro: user.distro, username, avatar});
    setSaving(false);
    if (result.kind === 'success') onSaved();
    else setError(`Couldn’t save (${result.code}). Try again.`);
  }, [avatar, onSave, onSaved, user.distro, username]);

  return (
    <View style={styles.card} testID="user-account-editor">
      <AvatarPicker onChange={setAvatar} value={avatar} />
      <TextInput
        accessibilityLabel="Username"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        maxLength={32}
        onChangeText={setUsername}
        placeholder="Username"
        placeholderTextColor={uiColors.subdued}
        style={styles.input}
        testID="user-account-username"
        value={username} />
      <Text style={styles.note}>
        {username === user.username ? `Your home is /home/${username}.` : `Your home becomes /home/${username}. Apps and shells already running keep the old name until they restart.`}
      </Text>
      {error === undefined ? null : <Text style={styles.error} testID="user-account-edit-error">{error}</Text>}
      <View style={styles.editButtons}>
        <Pressable accessibilityRole="button" disabled={saving} onPress={onCancel} style={styles.cancel} testID="user-account-edit-cancel">
          <Text style={styles.cancelText}>CANCEL</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving || !changed}
          onPress={() => { void save(); }}
          style={[styles.save, (saving || !changed) && styles.saveIdle]}
          testID="user-account-edit-save">
          <Text style={styles.saveText}>{saving ? 'SAVING…' : 'SAVE'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Log out takes a second tap, since it ends every running app and shell. */
function LogoutSection({onLogout}: Readonly<{onLogout: () => Promise<boolean>}>): React.JSX.Element {
  const [armed, setArmed] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const press = React.useCallback(async () => {
    if (!armed) {
      setArmed(true);
      setFailed(false);
      return;
    }
    setStopping(true);
    const stopped = await onLogout();
    if (!mountedRef.current) return;
    setStopping(false);
    setArmed(false);
    setFailed(!stopped);
  }, [armed, onLogout]);

  return (
    <SettingsSection
      footer={failed ? 'Couldn’t stop every session. Try again.' : undefined}
      footerTone="danger"
      title="LOG OUT">
      <SettingsRow
        detail={armed ? 'Every running app and shell will be stopped.' : 'Stops all running apps and shells, then locks Horus.'}
        label="Log out"
        right={(
          <SettingsAction
            disabled={stopping}
            label={stopping ? 'STOPPING…' : armed ? 'CONFIRM' : 'LOG OUT'}
            onPress={() => { void press(); }}
            testID="user-account-logout"
            tone="danger"
          />
        )}
        testID="user-account-logout-row"
      />
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  content: {paddingHorizontal: 18, paddingBottom: 28},
  card: {alignItems: 'center', backgroundColor: uiColors.panel, borderColor: uiColors.border, borderRadius: 14, borderWidth: 1, marginTop: 8, paddingHorizontal: 18, paddingVertical: 24},
  username: {color: uiColors.ink, fontFamily: UI_FONT_FAMILY, fontSize: 18, fontWeight: '800', marginTop: 12},
  distro: {color: uiColors.accent, fontFamily: UI_FONT_FAMILY, fontSize: 10, letterSpacing: 0.9, marginTop: 4},
  home: {color: uiColors.subdued, fontFamily: UI_FONT_FAMILY, fontSize: 11, marginTop: 8},
  editAction: {marginTop: 16},
  input: {alignSelf: 'stretch', backgroundColor: uiColors.background, borderColor: uiColors.borderSoft, borderRadius: 8, borderWidth: 1, color: uiColors.ink, fontFamily: UI_FONT_FAMILY, fontSize: 14, marginTop: 16, minHeight: 48, paddingHorizontal: 12},
  note: {alignSelf: 'stretch', color: uiColors.subdued, fontFamily: UI_FONT_FAMILY, fontSize: 10, lineHeight: 15, marginTop: 8},
  error: {alignSelf: 'stretch', color: uiColors.danger, fontFamily: UI_FONT_FAMILY, fontSize: 11, lineHeight: 16, marginTop: 8},
  editButtons: {alignSelf: 'stretch', flexDirection: 'row', gap: 8, marginTop: 16},
  cancel: {alignItems: 'center', borderColor: uiColors.borderSoft, borderRadius: 8, borderWidth: 1, flex: 1, justifyContent: 'center', minHeight: 44},
  cancelText: {color: uiColors.muted, fontFamily: UI_FONT_FAMILY, fontSize: 11, fontWeight: '800', letterSpacing: 0.6},
  save: {alignItems: 'center', backgroundColor: uiColors.accent, borderRadius: 8, flex: 1, justifyContent: 'center', minHeight: 44},
  saveIdle: {opacity: 0.4},
  saveText: {color: uiColors.background, fontFamily: UI_FONT_FAMILY, fontSize: 11, fontWeight: '900', letterSpacing: 0.6},
});
