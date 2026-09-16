import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN: number = 0x0000;
const TAG: string = 'MirrorView';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'Ability onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load content, code: %{public}s, message: %{public}s',
          JSON.stringify(err.code), JSON.stringify(err.message));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Succeeded in loading content');
      // 深色沉浸式：窗口与系统栏背景统一为页面深色，消除上下白条
      try {
        const win: window.Window = windowStage.getMainWindowSync();
        win.setWindowBackgroundColor('#0E1216');
        win.setWindowSystemBarProperties({
          statusBarColor: '#0E1216',
          statusBarContentColor: '#FFFFFF',
          navigationBarColor: '#0E1216',
          navigationBarContentColor: '#FFFFFF'
        });
        hilog.info(DOMAIN, TAG, 'window dark immersive applied');
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'set immersive style failed: %{public}s', JSON.stringify(e));
      }
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'Ability onBackground');
  }
}
