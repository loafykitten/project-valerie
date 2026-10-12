export type ServiceStatus = {
  service: string;
  mode: string;
  runtime: { hostname: string };
  characterImported: boolean;
  integrations: { name: string; configured: boolean; implemented: boolean }[];
};
