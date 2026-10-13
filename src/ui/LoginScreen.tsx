import React from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {DISTRO_NAMES, type ProfileUser} from '../profile/profileStore';
import {AuthScreenLayout, authStyles} from './AuthScreenLayout';
import {uiColors} from './brand';
import {InteractivePressable as Pressable} from './InteractivePressable';
import {ProfileAvatar} from './ProfileAvatar';
import {UI_FONT_FAMILY} from './typography';

export type LoginScreenProps = Readonly<{
  /** Every user, Alpine first; at most one per distribution. */
  users: readonly ProfileUser[];
  onLogin: (user: ProfileUser, password: string) => Promise<void>;
  error?: string;
  notice?: string;
}>;

/**
 * A Linux-style greeter: every user with their hieroglyph and distribution.
 * Picking one asks for that user's password; signing in also switches new
 * sessions to that user's distribution.
 */
export function LoginScreen({users, onLogin, error, notice}: LoginScreenProps): React.JSX.Element {
  const [selected, setSelected] = React.useState<ProfileUser | undefined>(users[0]);
  const [password, setPassword] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | undefined>();
  const passwordRef = React.useRef<React.ElementRef<typeof TextInput>>(null);

  const choose = React.useCallback((user: ProfileUser) => {
    setSelected(user);
    setPassword('');
    setValidationError(undefined);
    passwordRef.current?.focus();
  }, []);

  const submit = React.useCallback(async () => {
    if (selected === undefined) return;
    if (password.length < 4) {
      setValidationError(`Enter ${selected.username}’s password to unlock Horus.`);
      return;
    }
    setValidationError(undefined);
    setSaving(true);
    try {
      await onLogin(selected, password);
    } finally {
      setSaving(false);
      setPassword('');
    }
  }, [onLogin, password, selected]);

  return (
    <AuthScreenLayout brandTestID="login" screenTestID="login-screen">
      <View style={authStyles.card}>
        <View accessibilityRole="radiogroup" style={styles.users} testID="login-users">
          {users.map(user => {
            const isSelected = selected?.distro === user.distro;
            return (
              <Pressable
                key={user.distro}
                accessibilityLabel={`${user.username}, ${DISTRO_NAMES[user.distro]}`}
                accessibilityRole="radio"
                accessibilityState={{checked: isSelected}}
                // Keyboard focus would draw Android's square highlight over the
                // rounded tile, and leave it there; Tab goes to the password.
                focusable={false}
                onPress={() => choose(user)}
                style={[styles.user, isSelected && styles.userSelected]}
                testID={`login-user-${user.distro}${isSelected ? '-selected' : ''}`}>
                <ProfileAvatar avatar={user.avatar} selected={isSelected} size={users.length > 1 ? 72 : 88} />
                <Text numberOfLines={1} style={[styles.username, !isSelected && styles.dimmed]}>{user.username}</Text>
                <Text style={[styles.distro, isSelected && styles.distroSelected]}>{DISTRO_NAMES[user.distro].toUpperCase()}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          accessibilityLabel={selected === undefined ? 'Password' : `${selected.username}’s password`}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setPassword}
          onSubmitEditing={() => { void submit(); }}
          placeholder="Password"
          placeholderTextColor={uiColors.subdued}
          ref={passwordRef}
          returnKeyType="go"
          secureTextEntry
          style={authStyles.input}
          testID="login-password"
          value={password} />
        {notice !== undefined ? <Text style={authStyles.notice} testID="login-notice">{notice}</Text> : null}
        {validationError !== undefined ? <Text style={authStyles.error} testID="login-validation-error">{validationError}</Text> : null}
        {error !== undefined ? <Text style={authStyles.error} testID="login-error">{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={saving || selected === undefined} onPress={() => { void submit(); }} style={[authStyles.button, (saving || selected === undefined) && authStyles.disabled]} testID="login-submit">
          <Text style={authStyles.buttonText}>{saving ? 'SIGNING IN…' : 'SIGN IN  →'}</Text>
        </Pressable>
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  users: {flexDirection: 'row', gap: 14, justifyContent: 'center', marginBottom: 18},
  user: {alignItems: 'center', borderColor: 'transparent', borderRadius: 14, borderWidth: 1, maxWidth: 150, paddingHorizontal: 10, paddingVertical: 12},
  userSelected: {backgroundColor: uiColors.panelRaised, borderColor: uiColors.borderSoft},
  username: {color: uiColors.ink, fontFamily: UI_FONT_FAMILY, fontSize: 13, fontWeight: '800', marginTop: 10},
  dimmed: {color: uiColors.muted},
  distro: {color: uiColors.subdued, fontFamily: UI_FONT_FAMILY, fontSize: 8, letterSpacing: 0.9, marginTop: 4},
  distroSelected: {color: uiColors.accent},
});
