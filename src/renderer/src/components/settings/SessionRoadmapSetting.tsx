import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type SessionRoadmapSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** L1 feature switch (spec session-enablement §1): OFF stops all new roadmap
 * generation but keeps existing artifacts; takes effect on the next trigger. */
export function SessionRoadmapSetting({ settings, updateSettings }: SessionRoadmapSettingProps): React.JSX.Element {
  const enabled = settings.sessionRoadmap === true

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.sessionRoadmap.title', 'Session Roadmap')}
      description={translate(
        'auto.components.settings.ExperimentalPane.sessionRoadmap.description',
        'Generate per-session biography artifacts.'
      )}
      keywords={['roadmap', 'biography', 'session', '路线图']}
      className="space-y-3 py-2"
      id="experimental-session-roadmap"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate('auto.components.settings.ExperimentalPane.sessionRoadmap.title', 'Session Roadmap')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.sessionRoadmap.copy',
              'Sessions with substantive work get chapter/milestone biography cards. Turning this off stops new generation and keeps existing cards.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.sessionRoadmap.toggleLabel',
            'Toggle Session Roadmap'
          )}
          onChange={() => updateSettings({ sessionRoadmap: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
