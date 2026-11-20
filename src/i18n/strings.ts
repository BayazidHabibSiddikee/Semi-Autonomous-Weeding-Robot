export type AppLanguage = 'EN' | 'BN';

export const Strings = {
  appTitle: (lang: AppLanguage) => (lang === 'BN' ? 'নিড়ানি রোবট' : 'Weeding Robot'),
  appSubtitle: () => 'Semi-Autonomous Weeding Robot',

  navPlanner: (lang: AppLanguage) => (lang === 'BN' ? 'পথ পরিকল্পনা' : 'Path Planner'),
  navSimulator: (lang: AppLanguage) => (lang === 'BN' ? 'ফিল্ড সিমুলেটর' : 'Field Simulator'),
  navProject: (lang: AppLanguage) => (lang === 'BN' ? 'প্রজেক্ট বিবরণী ও ভিডিও' : 'Project & Demo'),
  navAbout: (lang: AppLanguage) => (lang === 'BN' ? 'পরিচিতি ও লক্ষ্য' : 'About Developer'),

  // Step 1
  step1Title: (lang: AppLanguage) =>
    lang === 'BN' ? '১. জমির ছবি ও চার কোণা নির্বাচন' : '1. Field Photo & 4 Corners',
  pickPhoto: (lang: AppLanguage, hasPhoto: Boolean) =>
    lang === 'BN'
      ? !hasPhoto
        ? 'ছবি নির্বাচন করুন (Pick Photo)'
        : 'ছবি পরিবর্তন করুন (Change Photo)'
      : !hasPhoto
      ? 'Pick Field Photo'
      : 'Change Photo',
  useSamplePhoto: (lang: AppLanguage) =>
    lang === 'BN' ? 'নমুনা জমির ছবি লোড করুন' : 'Load Sample Field Photo',
  noPhotoSelected: (lang: AppLanguage) =>
    lang === 'BN'
      ? 'কোনো ছবি নির্বাচন করা হয়নি। গ্যালারি থেকে ছবি নিন বা নমুনা ছবি লোড করুন।'
      : 'No photo selected. Choose a field image or load the bundled sample field.',
  dragHandleHint: (lang: AppLanguage) =>
    lang === 'BN'
      ? 'চারটি বৃত্তাকার পিন টেনে জমির ৪টি কোণায় বসান (TL, TR, BR, BL)'
      : 'Drag the 4 circular handles to the field corners (TL, TR, BR, BL)',

  // Step 2
  step2Title: (lang: AppLanguage) =>
    lang === 'BN' ? '২. জমির পরিমাপ ও বিন্যাস' : '2. Field Dimensions & Configuration',
  widthLabel: (lang: AppLanguage) => (lang === 'BN' ? 'প্রস্থ (Width m)' : 'Width (meters)'),
  lengthLabel: (lang: AppLanguage) => (lang === 'BN' ? 'দৈর্ঘ্য (Length m)' : 'Length (meters)'),
  totalRowsLabel: (lang: AppLanguage) => (lang === 'BN' ? 'মোট সারি (Rows)' : 'Total Rows'),
  rowSpacingLabel: (lang: AppLanguage) =>
    lang === 'BN' ? 'সারির দূরত্ব (Spacing m)' : 'Row Spacing (meters)',

  // Step 3
  generateMission: (lang: AppLanguage, isProcessing: boolean) =>
    lang === 'BN'
      ? isProcessing
        ? 'প্রসেসিং চলছে...'
        : '৩. স্বয়ংক্রিয় পথ পরিকল্পনা তৈরি করুন'
      : isProcessing
      ? 'Generating Mission...'
      : '3. Generate Boustrophedon Mission',
  missionReady: (lang: AppLanguage) =>
    lang === 'BN' ? 'মিশন প্রস্তুত (Mission Ready)' : 'Mission Generated Successfully',
  sendToPi: (lang: AppLanguage, ip: string) =>
    lang === 'BN' ? `রোবটে পাঠান (${ip})` : `Send to Robot (${ip})`,
  copyJson: (lang: AppLanguage) =>
    lang === 'BN' ? 'মিশন JSON কপি করুন' : 'Copy Mission JSON',
  downloadJson: (lang: AppLanguage) =>
    lang === 'BN' ? 'JSON ডাউনলোড' : 'Download JSON',
  jsonCopied: (lang: AppLanguage) =>
    lang === 'BN' ? 'মিশন JSON ক্লিপবোর্ডে কপি হয়েছে!' : 'Mission JSON copied to clipboard!',
  idleHint: (lang: AppLanguage) =>
    lang === 'BN'
      ? 'এখনো কোনো মিশন তৈরি হয়নি। উপরে জমির ছবি নিয়ে ৪টি কোণা চিহ্নিত করুন।'
      : 'No mission yet. Select a field photo and drag the 4 corner handles above.',
  retry: (lang: AppLanguage) => (lang === 'BN' ? 'পুনরায় চেষ্টা করুন (Retry)' : 'Retry'),
  simulateMission: (lang: AppLanguage) =>
    lang === 'BN' ? 'এই মিশনটি সিমুলেট করুন' : 'Simulate This Mission',
};
