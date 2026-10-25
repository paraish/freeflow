// No storage service: the person uploads the bundle wherever they like and
// pastes its address. Works for hosts that allow direct downloads from other
// sites (Dropbox, many lab and university servers, Zenodo).

// Turns common "share" pages into direct-download addresses.
export function directUrl(input) {
  let u;
  try { u = new URL(input.trim()); } catch { throw new Error('That is not a web address.'); }
  if (/(^|\.)dropbox\.com$/.test(u.hostname) && u.hostname !== 'dl.dropboxusercontent.com') {
    u.hostname = 'dl.dropboxusercontent.com';
    u.searchParams.delete('dl');
  }
  if (/drive\.google\.com|docs\.google\.com/.test(u.hostname)) {
    throw new Error('Google Drive does not let other sites download its files directly, so FreeFlow cannot open a Drive link. Use Dropbox, Zenodo or one of the storage services instead.');
  }
  if (u.protocol !== 'https:') throw new Error('Use an https:// address.');
  return u.toString();
}

export default {
  id: 'manual',
  label: 'I will upload the bundle myself',
  summary: 'Dropbox, Zenodo, a lab or university server: anywhere that allows direct downloads.',
  manual: true,
  fields: [
    { key: 'fileUrl', label: 'Address of the uploaded .zip', placeholder: 'https://…/my-analysis.zip', perLink: true },
  ],
  help: [
    'Download the bundle (above), upload it wherever you keep files, and copy its public or shared link.',
    'Dropbox share links are converted to direct downloads automatically. Google Drive links cannot work.',
    'If the host does not allow downloads from other sites, FreeFlow will say so when the link is opened.',
  ],
  async upload(_blob, _filename, cfg) {
    return directUrl(cfg.fileUrl || '');
  },
};
