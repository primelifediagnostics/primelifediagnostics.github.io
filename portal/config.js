// Prime Life Diagnostics – patient portal settings.
// The publishable key is designed to be public. Never put the secret / service_role key here.
window.PORTAL_CONFIG = {
  supabaseUrl: "https://yhrvnohrslilawzgqehn.supabase.co",
  supabaseKey: "sb_publishable_PWbMFdfCpF4OzZatPeETbA_fm9nY8zJ",
  siteUrl: "https://www.primelifediagnostics.co.uk/portal/",   // email links always open the website version
  vapidPublicKey: "BCOH4141aASVj593AZX3rEqPvDuEhSMKXif12CFEYypUOlAin02F6VXrzM0PqMvYXOyIodAEu7DE0sReJgPyIxA"   // public key for free notifications (the private key lives only in Supabase)
};
