declare module "expo-notifications" {
  export type NotificationPermissionStatus = {
    granted: boolean;
    status?: string;
  };

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
