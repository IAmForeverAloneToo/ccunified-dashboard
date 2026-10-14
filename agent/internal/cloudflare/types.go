package cloudflare

// Account is a Cloudflare account the token can use.
type Account struct{ ID, Name string }

// Zone is a domain on Cloudflare.
type Zone struct{ ID, Name string }

// Domain is a custom domain attached to a Worker.
type Domain struct{ ID, Hostname string }
