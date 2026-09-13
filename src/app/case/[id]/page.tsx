import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseDetailView } from "../../../components/case-detail";
import { isCaseId } from "../../../domain/identity";
import { getDatabase } from "../../../server/composition";
import { getCaseDetail } from "../../../server/services/case-query";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `${id} · CaseClosed` };
}

export default async function CasePage({ params }: Props) {
  const { id } = await params;
  if (!isCaseId(id)) notFound();
  const detail = getCaseDetail(getDatabase(), id);
  if (!detail) notFound();
  return <CaseDetailView initial={detail} />;
}
