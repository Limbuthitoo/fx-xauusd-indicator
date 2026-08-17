declare module "expo-notifications" {
  export type NotificationPermissionStatus = {
    granted: boolean;
    status?: string;
  };

  export enum AndroidImportance {
    MAX = 5
  }

  export function setNotificationChannelAsync(channelId: string, channel: {
    name: string;
    description?: string;
    importance?: AndroidImportance;
    sound?: string;
    enableVibrate?: boolean;
    vibrationPattern?: number[];
    lightColor?: string;
  }): Promise<unknown>;

  export function setNotificationHandler(handler: {
    handleNotification: () => Promise<{
      shouldShowAlert: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;
  }): void;

  export function getPermissionsAsync(): Promise<NotificationPermissionStatus>;
  export function requestPermissionsAsync(): Promise<NotificationPermissionStatus>;
  export function getExpoPushTokenAsync(options?: { projectId?: string }): Promise<{ data: string }>;
  export function getDevicePushTokenAsync(): Promise<{ data: string; type?: string }>;
  export function addNotificationResponseReceivedListener(listener: (response: any) => void): { remove: () => void };
  export function getLastNotificationResponseAsync(): Promise<any | null>;
}
