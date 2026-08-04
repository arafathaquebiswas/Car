const pool = require("../config/db");

async function get() {
  const [rows] = await pool.query("SELECT * FROM settings WHERE id = 1 LIMIT 1");
  const row = rows[0] || {};
  const defaultLogo = "/logo/NGO_logo_monogram.webp";
  const activeLogo = row.company_logo || row.logo_path || defaultLogo;
  return {
    officeName: row.office_name || "ATMABISWAS Fuel",
    logo: activeLogo,
    currency: row.currency_symbol || "৳",
    theme: row.theme || "auto",
    companyName: row.company_name || "ATMABISWAS",
    shortName: row.short_name || "ATMABISWAS Fuel",
    companyLogo: activeLogo,
    address: row.address || "",
    phone: row.phone || "",
    email: row.email || "",
    website: row.website || "atmabiswas.org",
    footerCopyright: row.footer_copyright || "© 2026 ATMABISWAS. All Rights Reserved. Powered by ATMABISWAS ICT",
    reportHeader: row.report_header || "",
    printHeader: row.print_header || "",
    printFooter: row.print_footer || "",
    faviconPath: row.favicon_path || activeLogo,
  };
}

async function update(fields) {
  const columnMap = {
    officeName: "office_name",
    logo: "logo_path",
    currency: "currency_symbol",
    theme: "theme",
    companyName: "company_name",
    shortName: "short_name",
    companyLogo: "company_logo",
    address: "address",
    phone: "phone",
    email: "email",
    website: "website",
    footerCopyright: "footer_copyright",
    reportHeader: "report_header",
    printHeader: "print_header",
    printFooter: "print_footer",
    faviconPath: "favicon_path",
  };

  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${column} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return get();

  await pool.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, params);
  return get();
}

module.exports = { get, update };
