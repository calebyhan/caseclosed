import Link from "next/link";
import { StatusBadge, formatTimestamp } from "../components/status";
import { getDatabase } from "../server/composition";
import { listRecentCases } from "../server/services/case-query";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const cases = listRecentCases(getDatabase());
  return (
    <section className="panel">
      <h1>Cases</h1>
      {cases.length === 0 ? (
        <p className="muted">No cases yet. Cases are created by the Slack <code>/caseclosed</code> command.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th>Report</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/case/${item.id}`}>{item.id}</Link>
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="report-cell">{item.report}</td>
                  <td className="nowrap">{formatTimestamp(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
