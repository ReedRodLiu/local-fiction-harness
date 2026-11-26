import {
  ProviderSetupWizard,
  type ProviderSetupWizardProps,
} from './ProviderSetupWizard.tsx';

export interface DeepSeekSetupWizardProps extends Omit<ProviderSetupWizardProps, 'verifyUrlBase'> {
  verifyUrlBase: string;
  onComplete: (apiKey: string) => void;
}

export function DeepSeekSetupWizard(props: DeepSeekSetupWizardProps) {
  return <ProviderSetupWizard {...props} />;
}
