import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { CompatVerdict } from '../transport/protocol-compat'

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'
const IOS_APP_STORE_URL = 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'

type Props = {
  verdict: Extract<CompatVerdict, { kind: 'blocked' | 'unknown' }>
  onRetry?: () => void
}

export function ProtocolBlockScreen({ verdict, onRetry }: Props) {
  const unknown = verdict.kind === 'unknown'
  const isMobileTooOld = verdict.kind === 'blocked' && verdict.reason === 'mobile-too-old'
  // Why: Android APKs ship through GitHub Releases until a Play Store listing exists.
  const mobileUpdateTarget =
    Platform.OS === 'ios'
      ? { label: 'Open App Store', url: IOS_APP_STORE_URL, storeName: 'the App Store' }
      : { label: 'Open GitHub Releases', url: RELEASES_URL, storeName: 'GitHub Releases' }
  const primaryAction = isMobileTooOld
    ? { label: mobileUpdateTarget.label, url: mobileUpdateTarget.url }
    : { label: 'Open GitHub Releases', url: RELEASES_URL }

  const title = unknown
    ? 'Unable to verify this host'
    : isMobileTooOld
      ? 'Update Orca Mobile'
      : 'Update Orca on your computer'
  const body = unknown
    ? 'Orca could not check this host’s compatibility. Retry the connection or choose another host.'
    : isMobileTooOld
      ? `This desktop needs a newer Orca Mobile app. Update Orca Mobile from ${mobileUpdateTarget.storeName}, then try this host again.`
      : 'This paired desktop app is too old for your current Orca Mobile app. Update Orca on your computer, then try this host again.'
  const recoveryNote =
    'Already updated? Go back to Hosts and refresh the connection. If this message stays, remove this host and pair it again.'

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={() => {
            if (unknown) {
              onRetry?.()
            } else {
              void Linking.openURL(primaryAction.url)
            }
          }}
        >
          <Text style={styles.primaryButtonText}>{unknown ? 'Retry' : primaryAction.label}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            // Why: route back to the host list so the user can pair a
            // different host instead of getting trapped on this screen.
            router.replace('/')
          }}
        >
          <Text style={styles.secondaryButtonText}>Back to hosts</Text>
        </Pressable>
        {!unknown ? <Text style={styles.recoveryNote}>{recoveryNote}</Text> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    backgroundColor: colors.bgBase,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm
  },
  body: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg
  },
  primaryButton: {
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  primaryButtonText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.bgBase
  },
  secondaryButton: {
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  secondaryButtonText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  recoveryNote: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 17,
    marginTop: spacing.md
  },
  pressed: {
    opacity: 0.7
  }
})
