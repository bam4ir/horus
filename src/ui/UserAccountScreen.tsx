import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {DISTRO_NAMES, LINUX_DISTROS, type ProfileUser} from '../profile/profileStore';
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
}>;

/** Everything about Linux users, opened from the user card on the home screen. */
export function UserAccountScreen({user, users, onBack, onAddUser, onSwitchUser, onLogout}: UserAccountScreenProps): React.JSX.Element {
  useHardwareBack(true, onBack);
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

        <View style={styles.card} testID="user-account-card">
          <ProfileAvatar avatar={user.avatar} selected size={72} />
          <Text numberOfLines={1} style={styles.username} testID="user-account-name">{user.username}</Text>
          <Text style={styles.distro}>{DISTRO_NAMES[user.distro].toUpperCase()}</Text>
          <Text style={styles.home} testID="user-account-home">/home/{user.username}</Text>
        </View>

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
});
