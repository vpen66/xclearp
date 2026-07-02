import { useState, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'upToDate' | 'error';

export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState({ downloaded: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const checkForUpdates = useCallback(async () => {
    try {
      setStatus('checking');
      setErrorMsg(null);
      
      const update = await check();
      
      if (update) {
        setUpdateInfo(update);
        setStatus('available');
        return update;
      } else {
        setUpdateInfo(null);
        setStatus('upToDate');
        return null;
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
      return null;
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!updateInfo) return;
    try {
      setStatus('downloading');
      let downloadedLength = 0;
      let contentLength = 0;

      await updateInfo.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            setDownloadProgress({ downloaded: 0, total: contentLength });
            break;
          case 'Progress':
            downloadedLength += event.data.chunkLength;
            setDownloadProgress((prev) => ({ ...prev, downloaded: downloadedLength }));
            break;
          case 'Finished':
            break;
        }
      });

      // After successful install, relaunch using custom command
      await invoke('relaunch');
    } catch (err) {
      console.error('Failed to install update:', err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [updateInfo]);

  return {
    status,
    updateInfo,
    downloadProgress,
    errorMsg,
    checkForUpdates,
    installUpdate,
  };
}
